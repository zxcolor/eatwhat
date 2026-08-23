package com.chishenme.app.data

import com.chishenme.app.data.remote.LocationSearchApi
import com.chishenme.app.data.remote.LocationSearchDataMode
import com.chishenme.app.data.remote.LocationSearchPlace
import com.chishenme.app.data.remote.LocationSearchQueryValidation
import com.chishenme.app.data.remote.LocationSearchQueryValidator
import com.chishenme.app.data.remote.LocationSearchRequest
import com.chishenme.app.data.remote.LocationSearchResponseValidator
import com.chishenme.app.data.remote.hasIncompatibleApiContractCause
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException

sealed interface LocationSearchOutcome {
    data class Success(
        val dataSource: String,
        val dataMode: LocationSearchDataMode,
        val results: List<LocationSearchPlace>,
        val notice: String?,
    ) : LocationSearchOutcome

    data class Empty(
        val dataSource: String,
        val dataMode: LocationSearchDataMode,
        val notice: String?,
    ) : LocationSearchOutcome

    data class Failure(val message: String) : LocationSearchOutcome
}

@Singleton
class LocationSearchRepository @Inject constructor(
    private val api: LocationSearchApi,
) {
    suspend fun search(query: String): LocationSearchOutcome {
        val normalized = when (val validation = LocationSearchQueryValidator.validate(query)) {
            is LocationSearchQueryValidation.Valid -> validation.normalizedQuery
            is LocationSearchQueryValidation.Invalid -> return LocationSearchOutcome.Failure(validation.message)
        }

        return try {
            val response = api.search(LocationSearchRequest(normalized))
            if (!LocationSearchResponseValidator.isValid(response)) {
                LocationSearchOutcome.Failure("地点搜索结果未通过安全校验，请重试")
            } else if (response.results.isEmpty()) {
                LocationSearchOutcome.Empty(response.dataSource, response.dataMode, response.notice)
            } else {
                LocationSearchOutcome.Success(
                    response.dataSource,
                    response.dataMode,
                    response.results,
                    response.notice,
                )
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            mapLocationSearchFailure(error)
        }
    }

    private fun mapLocationSearchFailure(error: Exception): LocationSearchOutcome.Failure {
        if (error.hasIncompatibleApiContractCause()) {
            return LocationSearchOutcome.Failure(
                "当前 App 与地点搜索服务版本不兼容，请更新 App 后重试",
            )
        }

        return when (error) {
            is UnknownHostException -> LocationSearchOutcome.Failure(
                "网络不可用，仍可选择下方内置地点",
            )
            is SocketTimeoutException -> LocationSearchOutcome.Failure(
                "地点搜索响应较慢，请重试或选择内置地点",
            )
            is HttpException -> try {
                val message = when (error.code()) {
                    400 -> "地点关键词无法搜索，请换一种写法"
                    429 -> "搜索请求有点多，请稍后重试"
                    in 500..599 -> "地点搜索服务暂时不可用，仍可选择内置地点"
                    else -> "地点搜索失败（${error.code()}）"
                }
                LocationSearchOutcome.Failure(message)
            } finally {
                runCatching { error.response()?.errorBody()?.close() }
            }
            is SerializationException -> LocationSearchOutcome.Failure(
                "地点搜索结果无法识别，请重试",
            )
            else -> LocationSearchOutcome.Failure(
                "暂时无法搜索地点，仍可选择内置地点",
            )
        }
    }
}
