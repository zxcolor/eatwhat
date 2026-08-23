package com.chishenme.app.data

import com.chishenme.app.data.remote.SupportFeedbackApi
import com.chishenme.app.data.remote.SupportFeedbackCategory
import com.chishenme.app.data.remote.SupportFeedbackContract
import com.chishenme.app.data.remote.SupportFeedbackRequest
import com.chishenme.app.data.remote.SupportFeedbackResponse
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException

enum class SupportFeedbackFailureKind {
    INPUT,
    LOGIN_STATE,
    CONFLICT,
    RATE_LIMITED,
    NETWORK,
    TIMEOUT,
    UNAVAILABLE,
    INVALID_RESPONSE,
    INCOMPATIBLE_API,
    UNKNOWN,
}

sealed interface SupportFeedbackOutcome<out Value> {
    data class Success<Value>(val value: Value) : SupportFeedbackOutcome<Value>
    data class Failure(
        val kind: SupportFeedbackFailureKind,
        val message: String,
    ) : SupportFeedbackOutcome<Nothing>
}

/** Narrow behavior boundary used by the feedback destination lifecycle gate. */
interface SupportFeedbackActions {
    suspend fun submit(
        submissionId: String,
        category: SupportFeedbackCategory,
        rawMessage: String,
        forceGuest: Boolean = false,
    ): SupportFeedbackOutcome<SupportFeedbackResponse>
}

/**
 * Submits a support ticket without writing its message, id or response to
 * DataStore, navigation arguments or logs.
 */
@Singleton
class SupportFeedbackRepository private constructor(
    private val api: SupportFeedbackApi,
    private val auth: OptionalAuthenticatedRequestExecutor,
) : SupportFeedbackActions {
    @Inject
    constructor(
        api: SupportFeedbackApi,
        authRepository: AuthRepository,
    ) : this(api, AuthRepositoryOptionalRequestExecutor(authRepository))

    internal constructor(
        api: SupportFeedbackApi,
        auth: OptionalAuthenticatedRequestExecutor,
        @Suppress("UNUSED_PARAMETER") testOnly: Unit = Unit,
    ) : this(api, auth)

    override suspend fun submit(
        submissionId: String,
        category: SupportFeedbackCategory,
        rawMessage: String,
        forceGuest: Boolean,
    ): SupportFeedbackOutcome<SupportFeedbackResponse> {
        if (!SupportFeedbackContract.isUuidV4(submissionId)) {
            return failure(SupportFeedbackFailureKind.INPUT, "无法创建安全的反馈提交标识，请重试")
        }
        if (!SupportFeedbackContract.isValidMessage(rawMessage)) {
            return failure(
                SupportFeedbackFailureKind.INPUT,
                "反馈正文需包含 10–2000 个字符，且不能含不可见控制字符",
            )
        }
        val request = SupportFeedbackRequest(
            submissionId = submissionId.lowercase(),
            category = category,
            message = SupportFeedbackContract.normalizeMessage(rawMessage),
        )

        return when (val outcome = auth.execute(forceGuest) { header ->
            api.submit(header, request)
        }) {
            is AuthOutcome.Failure -> mapAuthFailure(outcome)
            is AuthOutcome.Success -> {
                val response = outcome.value.value
                if (response.code() == 202) {
                    val body = response.body()
                    if (body != null && SupportFeedbackContract.isValidResponse(body, request.submissionId)) {
                        SupportFeedbackOutcome.Success(body)
                    } else {
                        invalidResponse()
                    }
                } else {
                    mapHttpFailure(
                        response.code(),
                        outcome.value.authenticationGeneration,
                    )
                }
            }
        }
    }

    private fun mapAuthFailure(failure: AuthOutcome.Failure): SupportFeedbackOutcome.Failure = when (
        failure.kind
    ) {
        AuthFailureKind.INPUT -> failure(SupportFeedbackFailureKind.INPUT, "提交的信息不符合要求")
        AuthFailureKind.NETWORK -> failure(SupportFeedbackFailureKind.NETWORK, "网络不可用，请检查连接后重试")
        AuthFailureKind.TIMEOUT -> failure(SupportFeedbackFailureKind.TIMEOUT, "反馈服务响应较慢，请稍后重试")
        AuthFailureKind.UNAUTHORIZED,
        AuthFailureKind.LOCAL_SECURITY -> failure(
            SupportFeedbackFailureKind.LOGIN_STATE,
            "本机存在无法安全验证的登录状态；为避免错误归属，本次没有降级为游客提交",
        )
        AuthFailureKind.FORBIDDEN -> failure(SupportFeedbackFailureKind.LOGIN_STATE, "当前账号不允许提交反馈")
        AuthFailureKind.CONFLICT -> conflict()
        AuthFailureKind.RATE_LIMITED -> rateLimited()
        AuthFailureKind.UNAVAILABLE -> unavailable()
        AuthFailureKind.INVALID_RESPONSE -> invalidResponse()
        AuthFailureKind.INCOMPATIBLE_API -> incompatible()
        AuthFailureKind.UNKNOWN -> failure(SupportFeedbackFailureKind.UNKNOWN, "反馈提交暂时失败，请重试")
    }

    private suspend fun mapHttpFailure(
        code: Int,
        authenticationGeneration: Long?,
    ): SupportFeedbackOutcome.Failure = when (code) {
        400 -> failure(SupportFeedbackFailureKind.INPUT, "反馈内容不符合要求，请检查后重试")
        401 -> if (authenticationGeneration != null) {
            try {
                auth.invalidateAuthentication(authenticationGeneration)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // The authoritative 401 remains actionable even when local
                // secure storage cleanup is temporarily unavailable.
            }
            failure(
                SupportFeedbackFailureKind.LOGIN_STATE,
                "登录状态已失效；为避免错误归属，本次没有降级为游客提交",
            )
        } else {
            incompatible()
        }
        403 -> failure(SupportFeedbackFailureKind.LOGIN_STATE, "当前账号不允许提交反馈")
        409 -> conflict()
        413, 415 -> incompatible()
        429 -> rateLimited()
        500, 503 -> unavailable()
        in 200..299 -> invalidResponse()
        else -> failure(SupportFeedbackFailureKind.UNKNOWN, "反馈服务暂时不可用，请稍后重试")
    }

    private fun conflict() = failure(
        SupportFeedbackFailureKind.CONFLICT,
        "本次提交标识已被其他内容使用，已为你准备新的提交；请确认后重试",
    )

    private fun rateLimited() = failure(
        SupportFeedbackFailureKind.RATE_LIMITED,
        "反馈提交过于频繁，请稍后再试；正文仍只保留在当前页面内存中",
    )

    private fun unavailable() = failure(
        SupportFeedbackFailureKind.UNAVAILABLE,
        "反馈服务暂时不可用，请稍后重试；也可通过原邀请测试渠道联系测试负责人",
    )

    private fun invalidResponse() = failure(
        SupportFeedbackFailureKind.INVALID_RESPONSE,
        "反馈服务响应未通过安全校验，本次不视为已提交",
    )

    private fun incompatible() = failure(
        SupportFeedbackFailureKind.INCOMPATIBLE_API,
        "当前 App 与反馈服务版本不兼容，请通过原邀请测试渠道更新 App",
    )

    private fun failure(kind: SupportFeedbackFailureKind, message: String) =
        SupportFeedbackOutcome.Failure(kind, message)
}

private class AuthRepositoryOptionalRequestExecutor(
    private val repository: AuthRepository,
) : OptionalAuthenticatedRequestExecutor {
    override suspend fun <Value> execute(
        forceGuest: Boolean,
        call: suspend (authorizationHeader: String?) -> Value,
    ): AuthOutcome<OptionalAuthenticatedCallResult<Value>> =
        repository.executeOptionallyAuthenticated(forceGuest, call)

    override suspend fun invalidateAuthentication(expectedGeneration: Long) {
        repository.clearLocalSessionIfGeneration(expectedGeneration)
    }
}
