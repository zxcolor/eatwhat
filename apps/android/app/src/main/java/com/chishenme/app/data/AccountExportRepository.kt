package com.chishenme.app.data

import com.chishenme.app.data.remote.AccountExportApi
import com.chishenme.app.data.remote.AccountExportContract
import com.chishenme.app.data.remote.AccountExportContentApi
import com.chishenme.app.data.remote.AccountExportLatestResponse
import com.chishenme.app.data.remote.AccountExportRequest
import com.chishenme.app.data.remote.AccountExportResponse
import com.chishenme.app.data.remote.AccountExportStatus
import com.chishenme.app.data.remote.AccountExportStatusResponse
import java.util.Base64
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okhttp3.ResponseBody
import retrofit2.Response

enum class AccountExportFailureKind {
    INPUT,
    LOGIN_STATE,
    NOT_FOUND,
    NOT_READY,
    EXPIRED,
    RATE_LIMITED,
    NETWORK,
    TIMEOUT,
    UNAVAILABLE,
    DESTINATION,
    TRANSFER,
    INVALID_RESPONSE,
    INCOMPATIBLE_API,
    UNKNOWN,
}

sealed interface AccountExportOutcome<out Value> {
    data class Success<Value>(val value: Value) : AccountExportOutcome<Value>
    data class Failure(
        val kind: AccountExportFailureKind,
        val message: String,
    ) : AccountExportOutcome<Nothing>
}

@Singleton
class AccountExportRepository private constructor(
    private val api: AccountExportApi,
    private val contentApi: AccountExportContentApi,
    private val auth: GenerationAuthenticatedRequestExecutor,
    private val documentWriter: AccountExportDocumentWriter,
) : AccountExportActions {
    @Inject
    internal constructor(
        api: AccountExportApi,
        contentApi: AccountExportContentApi,
        authRepository: AuthRepository,
        documentWriter: AndroidAccountExportDocumentWriter,
    ) : this(api, contentApi, AuthRepositoryGenerationExecutor(authRepository), documentWriter)

    internal constructor(
        api: AccountExportApi,
        contentApi: AccountExportContentApi,
        auth: GenerationAuthenticatedRequestExecutor,
        documentWriter: AccountExportDocumentWriter,
        @Suppress("UNUSED_PARAMETER") testOnly: Unit = Unit,
    ) : this(api, contentApi, auth, documentWriter)

    override suspend fun request(includeBehaviorHistory: Boolean): AccountExportOutcome<AccountExportResponse> {
        val request = AccountExportRequest(
            format = "JSON",
            includeBehaviorHistory = includeBehaviorHistory,
        )
        return authenticatedCall { header -> api.requestExport(header, request) }
            .parse(
                expectedCode = 202,
                validate = { AccountExportContract.validQueuedReceipt(it, includeBehaviorHistory) },
            )
    }

    override suspend fun latest(): AccountExportOutcome<AccountExportStatusResponse?> =
        when (val result = authenticatedCall { header -> api.latestExport(header) }) {
            is AuthenticatedHttp.Failure -> result.failure
            is AuthenticatedHttp.Response -> {
                val response = result.response
                if (response.code() != 200) {
                    response.errorBody()?.close()
                    mapHttpFailure(response.code(), result.authenticationGeneration)
                } else if (!result.authenticationIsCurrent()) {
                    authenticationChanged()
                } else {
                    val body: AccountExportLatestResponse? = response.body()
                    if (body == null) {
                        invalidResponse()
                    } else if (body.item == null || AccountExportContract.validStatus(body.item)) {
                        AccountExportOutcome.Success(body.item)
                    } else {
                        invalidResponse()
                    }
                }
            }
        }

    suspend fun status(exportId: String): AccountExportOutcome<AccountExportStatusResponse> {
        if (!AccountExportContract.isCanonicalUuid(exportId)) return invalidExportId()
        return authenticatedCall { header -> api.exportStatus(header, exportId.lowercase()) }
            .parse(
                expectedCode = 200,
                validate = { AccountExportContract.validStatus(it, exportId) },
            )
    }

    override suspend fun download(
        status: AccountExportStatusResponse,
        destinationUri: String,
    ): AccountExportOutcome<Unit> {
        if (!documentWriter.supports(destinationUri)) {
            return failure(AccountExportFailureKind.DESTINATION, "未能安全使用所选保存位置，请重新选择")
        }

        var completed = false
        try {
            if (!AccountExportContract.validStatus(status, status.exportId) ||
                status.status != AccountExportStatus.READY ||
                !status.downloadAvailable
            ) {
                return failure(AccountExportFailureKind.NOT_READY, "导出文件尚未准备好，请先刷新状态")
            }
            val outcome = when (
                val result = authenticatedCall { header ->
                    contentApi.exportContent(header, status.exportId)
                }
            ) {
                is AuthenticatedHttp.Failure -> result.failure
                is AuthenticatedHttp.Response -> downloadResponse(result, status, destinationUri)
            }
            completed = outcome is AccountExportOutcome.Success
            return outcome
        } catch (error: CancellationException) {
            throw error
        } finally {
            if (!completed) {
                withContext(NonCancellable) {
                    runCatching { documentWriter.discard(destinationUri) }
                }
            }
        }
    }

    private suspend fun downloadResponse(
        result: AuthenticatedHttp.Response<ResponseBody>,
        status: AccountExportStatusResponse,
        destinationUri: String,
    ): AccountExportOutcome<Unit> {
        val response = result.response
        if (response.code() != 200) {
            response.errorBody()?.close()
            return mapHttpFailure(response.code(), result.authenticationGeneration)
        }
        if (response.raw().priorResponse != null || !validContentHeaders(response, status)) {
            response.body()?.close()
            return invalidResponse()
        }
        val body = response.body() ?: return invalidResponse()
        if (!result.authenticationIsCurrent()) {
            body.close()
            return downloadAuthenticationChanged()
        }
        return body.use {
            when (
                documentWriter.write(
                    destinationUri = destinationUri,
                    input = it.byteStream(),
                    expectedSizeBytes = requireNotNull(status.sizeBytes),
                    expectedSha256 = requireNotNull(status.sha256),
                )
            ) {
                AccountExportWriteResult.SUCCESS -> {
                    if (result.authenticationIsCurrent()) {
                        AccountExportOutcome.Success(Unit)
                    } else {
                        downloadAuthenticationChanged()
                    }
                }
                AccountExportWriteResult.INVALID_CONTENT -> invalidResponse()
                AccountExportWriteResult.DESTINATION_UNAVAILABLE -> failure(
                    AccountExportFailureKind.DESTINATION,
                    "无法写入所选位置；App 已尝试删除或清空未完成文件",
                )
                AccountExportWriteResult.TRANSFER_FAILED -> failure(
                    AccountExportFailureKind.TRANSFER,
                    "下载或写入过程中断；App 已尝试删除或清空未完成文件",
                )
            }
        }
    }

    private fun validContentHeaders(
        response: Response<ResponseBody>,
        status: AccountExportStatusResponse,
    ): Boolean {
        val size = status.sizeBytes ?: return false
        val checksum = status.sha256 ?: return false
        val body = response.body() ?: return false
        val headers = response.headers()
        val contentLength = headers.singleValue("Content-Length")?.toLongOrNull() ?: return false
        val expectedDigest = "sha-256=${Base64.getEncoder().encodeToString(checksum.hexToBytes())}"
        return contentLength == size &&
            body.contentLength() == size &&
            headers.singleValue("Content-Type").equals(EXPORT_CONTENT_TYPE, ignoreCase = true) &&
            headers.singleValue("X-Content-SHA256") == checksum &&
            headers.singleValue("Digest") == expectedDigest &&
            headers.singleValue("Content-Disposition") == EXPORT_CONTENT_DISPOSITION &&
            headers.singleValue("Cache-Control").equals(EXPORT_CACHE_CONTROL, ignoreCase = true) &&
            headers.values("Content-Encoding").isEmpty()
    }

    private suspend fun <Body> authenticatedCall(
        call: suspend (authorizationHeader: String) -> Response<Body>,
    ): AuthenticatedHttp<Body> = when (val outcome = auth.execute(call)) {
        is AuthOutcome.Failure -> AuthenticatedHttp.Failure(mapAuthFailure(outcome))
        is AuthOutcome.Success -> AuthenticatedHttp.Response(
            response = outcome.value.value,
            authenticationGeneration = outcome.value.authenticationGeneration,
            userId = outcome.value.userId,
            sessionId = outcome.value.sessionId,
        )
    }

    private suspend fun AuthenticatedHttp.Response<*>.authenticationIsCurrent(): Boolean = try {
        auth.isAuthenticationCurrent(
            expectedGeneration = authenticationGeneration,
            expectedUserId = userId,
            expectedSessionId = sessionId,
        )
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        false
    }

    private suspend fun <Body> AuthenticatedHttp<Body>.parse(
        expectedCode: Int,
        validate: (Body) -> Boolean,
    ): AccountExportOutcome<Body> = when (this) {
        is AuthenticatedHttp.Failure -> failure
        is AuthenticatedHttp.Response -> {
            if (response.code() != expectedCode) {
                response.errorBody()?.close()
                mapHttpFailure(response.code(), authenticationGeneration)
            } else if (!authenticationIsCurrent()) {
                authenticationChanged()
            } else {
                val body = response.body()
                if (body != null && validate(body)) AccountExportOutcome.Success(body) else invalidResponse()
            }
        }
    }

    private fun mapAuthFailure(failure: AuthOutcome.Failure): AccountExportOutcome.Failure = when (
        failure.kind
    ) {
        AuthFailureKind.INPUT -> failure(AccountExportFailureKind.INPUT, "提交的信息不符合要求")
        AuthFailureKind.UNAUTHORIZED,
        AuthFailureKind.LOCAL_SECURITY,
        -> failure(AccountExportFailureKind.LOGIN_STATE, "登录状态无法安全验证，请重新登录后再试")
        AuthFailureKind.FORBIDDEN -> failure(AccountExportFailureKind.LOGIN_STATE, "当前账号不允许导出数据")
        AuthFailureKind.NETWORK -> failure(AccountExportFailureKind.NETWORK, "网络不可用，请检查连接后重试")
        AuthFailureKind.TIMEOUT -> failure(AccountExportFailureKind.TIMEOUT, "数据导出服务响应较慢，请稍后重试")
        AuthFailureKind.RATE_LIMITED -> rateLimited()
        AuthFailureKind.UNAVAILABLE -> unavailable()
        AuthFailureKind.INVALID_RESPONSE -> invalidResponse()
        AuthFailureKind.INCOMPATIBLE_API -> incompatible()
        AuthFailureKind.CONFLICT,
        AuthFailureKind.UNKNOWN,
        -> failure(AccountExportFailureKind.UNKNOWN, "数据导出操作暂时失败，请重试")
    }

    private suspend fun mapHttpFailure(
        code: Int,
        authenticationGeneration: Long,
    ): AccountExportOutcome.Failure = when (code) {
        400 -> failure(AccountExportFailureKind.INPUT, "数据导出参数不符合要求")
        401 -> {
            try {
                auth.invalidateAuthentication(authenticationGeneration)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // The authoritative 401 remains actionable even if secure
                // storage cleanup is temporarily unavailable.
            }
            failure(AccountExportFailureKind.LOGIN_STATE, "登录状态已失效，请重新登录后再试")
        }
        403 -> failure(AccountExportFailureKind.LOGIN_STATE, "当前账号不允许导出数据")
        404 -> failure(AccountExportFailureKind.NOT_FOUND, "未找到这次数据导出任务")
        409 -> failure(AccountExportFailureKind.NOT_READY, "导出文件尚未准备好，请刷新状态")
        410 -> failure(AccountExportFailureKind.EXPIRED, "导出文件已过期，请重新申请")
        429 -> rateLimited()
        500, 503 -> unavailable()
        413, 415 -> incompatible()
        in 200..299 -> invalidResponse()
        else -> failure(AccountExportFailureKind.UNKNOWN, "数据导出服务暂时不可用，请稍后重试")
    }

    private fun invalidExportId() = failure(AccountExportFailureKind.INPUT, "数据导出任务编号无效")

    private fun rateLimited() = failure(AccountExportFailureKind.RATE_LIMITED, "数据导出操作过于频繁，请稍后再试")

    private fun unavailable() = failure(AccountExportFailureKind.UNAVAILABLE, "数据导出服务暂时不可用，请稍后重试")

    private fun invalidResponse() = failure(
        AccountExportFailureKind.INVALID_RESPONSE,
        "数据导出响应未通过安全校验，本次不视为成功",
    )

    private fun incompatible() = failure(
        AccountExportFailureKind.INCOMPATIBLE_API,
        "当前 App 与数据导出服务版本不兼容，请更新 App",
    )

    private fun authenticationChanged() = failure(
        AccountExportFailureKind.LOGIN_STATE,
        "请求期间登录账号已变化，请刷新后重试",
    )

    private fun downloadAuthenticationChanged() = failure(
        AccountExportFailureKind.LOGIN_STATE,
        "下载期间登录账号已变化；未完成文件已删除或清空，请重新申请",
    )

    private fun failure(kind: AccountExportFailureKind, message: String) =
        AccountExportOutcome.Failure(kind, message)

    private fun String.hexToBytes(): ByteArray = chunked(2)
        .map { it.toInt(16).toByte() }
        .toByteArray()

    private fun okhttp3.Headers.singleValue(name: String): String? =
        values(name).singleOrNull()

    private sealed interface AuthenticatedHttp<out Body> {
        data class Response<Body>(
            val response: retrofit2.Response<Body>,
            val authenticationGeneration: Long,
            val userId: String,
            val sessionId: String,
        ) : AuthenticatedHttp<Body>

        data class Failure(val failure: AccountExportOutcome.Failure) : AuthenticatedHttp<Nothing>
    }

    private companion object {
        const val EXPORT_CONTENT_TYPE = "application/json; charset=utf-8"
        const val EXPORT_CONTENT_DISPOSITION = "attachment; filename=\"chi-shen-me-account-export.json\""
        const val EXPORT_CACHE_CONTROL = "private, no-store"
    }
}

private class AuthRepositoryGenerationExecutor(
    private val repository: AuthRepository,
) : GenerationAuthenticatedRequestExecutor {
    override suspend fun <Value> execute(
        call: suspend (authorizationHeader: String) -> Value,
    ): AuthOutcome<AuthenticatedCallResult<Value>> =
        repository.executeAuthenticatedWithGeneration(call)

    override suspend fun invalidateAuthentication(expectedGeneration: Long) {
        repository.clearLocalSessionIfGeneration(expectedGeneration)
    }

    override suspend fun isAuthenticationCurrent(
        expectedGeneration: Long,
        expectedUserId: String,
        expectedSessionId: String,
    ): Boolean = repository.isLocalAuthenticationCurrent(
        expectedGeneration = expectedGeneration,
        expectedUserId = expectedUserId,
        expectedSessionId = expectedSessionId,
    )
}
