package com.chishenme.app.data

import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.PlaceSearchApi
import com.chishenme.app.data.remote.PlaceSearchRequest
import com.chishenme.app.data.remote.PlaceSearchRequestValidator
import com.chishenme.app.data.remote.PlaceSearchResponse
import com.chishenme.app.data.remote.PlaceSearchResponseValidator
import com.chishenme.app.data.remote.hasIncompatibleApiContractCause
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException

enum class PlaceSearchFailureKind {
    INPUT,
    NETWORK,
    TIMEOUT,
    RATE_LIMITED,
    UNAVAILABLE,
    INVALID_RESPONSE,
    INCOMPATIBLE_API,
    UNKNOWN,
}

sealed interface PlaceSearchOutcome {
    data class Success(val response: PlaceSearchResponse) : PlaceSearchOutcome
    data class Empty(val response: PlaceSearchResponse) : PlaceSearchOutcome
    data class OutsidePilot(val response: PlaceSearchResponse) : PlaceSearchOutcome
    data class Failure(
        val kind: PlaceSearchFailureKind,
        val message: String,
    ) : PlaceSearchOutcome
}

@Singleton
class PlaceSearchRepository @Inject constructor(
    private val api: PlaceSearchApi,
) {
    suspend fun search(request: PlaceSearchRequest): PlaceSearchOutcome {
        if (!PlaceSearchRequestValidator.isValid(request)) {
            return failure(PlaceSearchFailureKind.INPUT, "搜索条件不符合要求，请检查后重试")
        }
        return try {
            val response = api.search(request)
            when {
                !PlaceSearchResponseValidator.isValid(response, request) -> failure(
                    PlaceSearchFailureKind.INVALID_RESPONSE,
                    "餐厅搜索结果未通过安全校验，请重试",
                )
                response.coverage == Coverage.OUTSIDE_PILOT -> PlaceSearchOutcome.OutsidePilot(response)
                response.results.isEmpty() -> PlaceSearchOutcome.Empty(response)
                else -> PlaceSearchOutcome.Success(response)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            mapFailure(error)
        }
    }

    private fun mapFailure(error: Exception): PlaceSearchOutcome.Failure {
        if (error.hasIncompatibleApiContractCause()) {
            return failure(
                PlaceSearchFailureKind.INCOMPATIBLE_API,
                "当前 App 与餐厅搜索服务版本不兼容，请更新 App 后重试",
            )
        }
        return when (error) {
            is UnknownHostException -> failure(PlaceSearchFailureKind.NETWORK, "网络不可用，请检查连接后重试")
            is SocketTimeoutException -> failure(PlaceSearchFailureKind.TIMEOUT, "餐厅搜索响应较慢，请稍后重试")
            is HttpException -> mapHttpFailure(error)
            is SerializationException -> failure(
                PlaceSearchFailureKind.INVALID_RESPONSE,
                "餐厅搜索结果无法识别，请重试",
            )
            else -> failure(PlaceSearchFailureKind.UNKNOWN, "暂时无法搜索附近餐厅，请重试")
        }
    }

    private fun mapHttpFailure(error: HttpException): PlaceSearchOutcome.Failure = try {
        when (error.code()) {
            400 -> failure(PlaceSearchFailureKind.INPUT, "搜索词或筛选条件无法处理，请调整后重试")
            404, 413, 415 -> failure(
                PlaceSearchFailureKind.INCOMPATIBLE_API,
                "当前 App 与餐厅搜索服务版本不兼容，请更新 App 后重试",
            )
            429 -> failure(PlaceSearchFailureKind.RATE_LIMITED, "搜索请求有点多，请稍后重试")
            503 -> failure(PlaceSearchFailureKind.UNAVAILABLE, "餐厅搜索服务暂时不可用，请稍后重试")
            in 500..599 -> failure(PlaceSearchFailureKind.UNAVAILABLE, "餐厅搜索服务暂时不可用，请稍后重试")
            else -> failure(PlaceSearchFailureKind.UNKNOWN, "餐厅搜索失败，请稍后重试")
        }
    } finally {
        runCatching { error.response()?.errorBody()?.close() }
    }

    private fun failure(kind: PlaceSearchFailureKind, message: String) =
        PlaceSearchOutcome.Failure(kind, message)
}
