package com.chishenme.app.data

import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.RecommendationApi
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationEvent
import com.chishenme.app.data.remote.RecommendationEventType
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResponseValidator
import com.chishenme.app.data.remote.ResultTokenValidator
import com.chishenme.app.data.remote.hasIncompatibleApiContractCause
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException

sealed interface RecommendationOutcome {
    data class Success(val response: RecommendationResponse) : RecommendationOutcome
    data class Failure(val kind: FailureKind, val message: String) : RecommendationOutcome
}

enum class FailureKind { NETWORK, TIMEOUT, SERVER, INVALID_RESPONSE, INCOMPATIBLE_API, UNKNOWN }

internal sealed interface FeatureConfigOutcome {
    data class Success(val config: FeatureConfig) : FeatureConfigOutcome
    data object Unavailable : FeatureConfigOutcome
    data object Incompatible : FeatureConfigOutcome
}

@Singleton
class RecommendationRepository @Inject constructor(
    private val api: RecommendationApi,
) {
    internal suspend fun featureConfig(): FeatureConfigOutcome = try {
        val config = api.featureConfig()
        if (
            config.coverageName.isNotBlank() &&
                config.recommendationDefaults?.isValid() != false &&
                config.minimumSupportedVersion.matches(Regex("^\\d+\\.\\d+\\.\\d+$")) &&
                config.ruleVersion.isNotBlank() &&
                config.promptVersion.isNotBlank() &&
                config.modelVersion.isNotBlank() &&
                config.persistenceCapabilities?.let { capabilities ->
                    capabilities.favoritesEnabled == config.favoritesEnabled &&
                        (config.dataRightsMode != com.chishenme.app.data.remote.DataRightsMode.LIVE_DISPLAY_ONLY ||
                            listOf(
                                capabilities.favoritesEnabled,
                                capabilities.historyEnabled,
                                capabilities.privateFeedbackEnabled,
                                capabilities.savedResourceIdsEnabled,
                            ).none { it })
                } != false &&
                config.authCapabilities?.let { capabilities ->
                    capabilities.accountsEnabled == config.accountsEnabled &&
                        (!capabilities.dataExportEnabled || capabilities.accountsEnabled) &&
                        (!capabilities.registrationEnabled ||
                            capabilities.accountsEnabled &&
                            capabilities.phoneEnabled) &&
                        (capabilities.accountsEnabled ||
                            listOf(
                                capabilities.registrationEnabled,
                                capabilities.phoneEnabled,
                                capabilities.wechatEnabled,
                                capabilities.emailEnabled,
                                capabilities.qqEnabled,
                                capabilities.dataExportEnabled,
                            ).none { it })
                } != false &&
                (config.dataRightsMode != com.chishenme.app.data.remote.DataRightsMode.LIVE_DISPLAY_ONLY ||
                    !config.favoritesEnabled)
        ) {
            FeatureConfigOutcome.Success(config)
        } else {
            FeatureConfigOutcome.Unavailable
        }
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        if (error.hasIncompatibleApiContractCause()) {
            FeatureConfigOutcome.Incompatible
        } else {
            FeatureConfigOutcome.Unavailable
        }
    }

    suspend fun recommend(context: RecommendationContext): RecommendationOutcome = try {
        val response = api.recommend(context)
        if (RecommendationResponseValidator.isValid(response, context)) {
            RecommendationOutcome.Success(response)
        } else {
            RecommendationOutcome.Failure(FailureKind.INVALID_RESPONSE, "服务返回的数据未通过安全校验")
        }
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        mapRecommendationFailure(error)
    }

    suspend fun recordEvent(
        requestId: String,
        resultToken: String,
        type: RecommendationEventType,
    ) {
        if (!ResultTokenValidator.isValid(resultToken)) return
        try {
            api.recordEvent(
                RecommendationEvent(
                    requestId = requestId,
                    resultToken = resultToken,
                    type = type,
                    occurredAt = Instant.now().toString(),
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Analytics is best-effort and must not interrupt the decision flow.
        }
    }

    private fun mapRecommendationFailure(error: Exception): RecommendationOutcome.Failure {
        if (error.hasIncompatibleApiContractCause()) {
            return RecommendationOutcome.Failure(
                FailureKind.INCOMPATIBLE_API,
                "当前 App 与推荐服务版本不兼容，请更新 App 后重试",
            )
        }

        return when (error) {
            is UnknownHostException -> RecommendationOutcome.Failure(
                FailureKind.NETWORK,
                "网络不可用，请检查连接后重试",
            )
            is SocketTimeoutException -> RecommendationOutcome.Failure(
                FailureKind.TIMEOUT,
                "推荐服务响应较慢，请稍后重试",
            )
            is HttpException -> try {
                val message = when (error.code()) {
                    400 -> if (error.isActiveCoverageRejection()) {
                        "服务范围已更新，请重新连接服务，再调整最远距离后重试。"
                    } else {
                        "推荐条件有误，请调整后重试"
                    }
                    429 -> "请求有点多，请稍后再试"
                    in 500..599 -> "推荐服务暂时不可用，请稍后重试"
                    else -> "请求失败（${error.code()}）"
                }
                RecommendationOutcome.Failure(FailureKind.SERVER, message)
            } finally {
                runCatching { error.response()?.errorBody()?.close() }
            }
            is SerializationException -> RecommendationOutcome.Failure(
                FailureKind.INVALID_RESPONSE,
                "服务返回的数据无法识别",
            )
            else -> RecommendationOutcome.Failure(
                FailureKind.UNKNOWN,
                "暂时无法生成推荐，请重试",
            )
        }
    }
}
