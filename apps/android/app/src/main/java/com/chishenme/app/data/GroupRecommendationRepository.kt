package com.chishenme.app.data

import com.chishenme.app.data.remote.GroupConstraintAggregation
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.GroupRecommendationApi
import com.chishenme.app.data.remote.GroupRecommendationRequest
import com.chishenme.app.data.remote.GroupRecommendationResponse
import com.chishenme.app.data.remote.GroupRecommendationResponseValidator
import com.chishenme.app.data.remote.hasIncompatibleApiContractCause
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException

sealed interface GroupRecommendationOutcome {
    data class Success(val response: GroupRecommendationResponse) : GroupRecommendationOutcome
    data class Failure(
        val kind: GroupRecommendationFailureKind,
        val message: String,
    ) : GroupRecommendationOutcome
}

enum class GroupRecommendationFailureKind {
    NETWORK,
    TIMEOUT,
    SERVER,
    INVALID_RESPONSE,
    INCOMPATIBLE_API,
    UNKNOWN,
}

@Singleton
class GroupRecommendationRepository @Inject constructor(
    private val api: GroupRecommendationApi,
) {
    suspend fun recommend(
        request: GroupRecommendationRequest,
        expectedAggregation: GroupConstraintAggregation,
        expectedDataRightsMode: DataRightsMode,
        expectedRuleVersion: String,
    ): GroupRecommendationOutcome = try {
        val response = api.recommend(request)
        if (
            GroupRecommendationResponseValidator.isValid(
                response = response,
                request = request,
                expectedAggregation = expectedAggregation,
                expectedDataRightsMode = expectedDataRightsMode,
                expectedRuleVersion = expectedRuleVersion,
            )
        ) {
            GroupRecommendationOutcome.Success(response)
        } else {
            GroupRecommendationOutcome.Failure(
                GroupRecommendationFailureKind.INVALID_RESPONSE,
                "群组推荐结果未通过共同条件校验，请重新发起",
            )
        }
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        mapFailure(error)
    }

    private fun mapFailure(error: Exception): GroupRecommendationOutcome.Failure {
        if (error.hasIncompatibleApiContractCause()) {
            return GroupRecommendationOutcome.Failure(
                GroupRecommendationFailureKind.INCOMPATIBLE_API,
                "当前 App 与群组推荐服务版本不兼容，请更新 App 后重试",
            )
        }
        return when (error) {
            is UnknownHostException -> GroupRecommendationOutcome.Failure(
                GroupRecommendationFailureKind.NETWORK,
                "网络不可用，请检查连接后重试",
            )
            is SocketTimeoutException -> GroupRecommendationOutcome.Failure(
                GroupRecommendationFailureKind.TIMEOUT,
                "群组推荐服务响应较慢，请稍后重试",
            )
            is HttpException -> try {
                val message = when (error.code()) {
                    400 -> "成员条件有误，请返回重新录入"
                    429 -> "请求有点多，请稍后再试"
                    in 500..599 -> "群组推荐服务暂时不可用，请稍后重试"
                    else -> "请求失败（${error.code()}）"
                }
                GroupRecommendationOutcome.Failure(GroupRecommendationFailureKind.SERVER, message)
            } finally {
                runCatching { error.response()?.errorBody()?.close() }
            }
            is SerializationException,
            is IllegalArgumentException,
            -> GroupRecommendationOutcome.Failure(
                GroupRecommendationFailureKind.INVALID_RESPONSE,
                "群组推荐服务返回的数据无法识别",
            )
            else -> GroupRecommendationOutcome.Failure(
                GroupRecommendationFailureKind.UNKNOWN,
                "暂时无法生成群组推荐，请重试",
            )
        }
    }
}
