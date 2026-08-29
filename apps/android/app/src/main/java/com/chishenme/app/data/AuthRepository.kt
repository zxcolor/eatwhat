package com.chishenme.app.data

import com.chishenme.app.BuildConfig
import com.chishenme.app.data.local.AuthSessionStore
import com.chishenme.app.data.local.AuthSessionToPersist
import com.chishenme.app.data.remote.AuthApi
import com.chishenme.app.data.remote.AuthCodeChallenge
import com.chishenme.app.data.remote.AuthDeviceContext
import com.chishenme.app.data.remote.AuthErrorResponse
import com.chishenme.app.data.remote.AuthIdentityBinding
import com.chishenme.app.data.remote.AuthIdentityBindingsResponse
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthLoginMethod
import com.chishenme.app.data.remote.AuthLoginRequest
import com.chishenme.app.data.remote.AuthResponseValidator
import com.chishenme.app.data.remote.AuthSessionSummary
import com.chishenme.app.data.remote.AuthSessionsResponse
import com.chishenme.app.data.remote.AuthTokenResponse
import com.chishenme.app.data.remote.BindIdentityRequest
import com.chishenme.app.data.remote.DeleteAccountRequest
import com.chishenme.app.data.remote.DeleteAccountResponse
import com.chishenme.app.data.remote.EmailCodeRequest
import com.chishenme.app.data.remote.OAuthPurpose
import com.chishenme.app.data.remote.OAuthStateRequest
import com.chishenme.app.data.remote.OAuthStateResponse
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.data.remote.PhoneCodeRequest
import com.chishenme.app.data.remote.RefreshSessionRequest
import com.chishenme.app.data.remote.hasIncompatibleApiContractCause
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import retrofit2.HttpException

enum class AuthFailureKind {
    INPUT,
    NETWORK,
    TIMEOUT,
    UNAUTHORIZED,
    FORBIDDEN,
    CONFLICT,
    RATE_LIMITED,
    UNAVAILABLE,
    INVALID_RESPONSE,
    INCOMPATIBLE_API,
    LOCAL_SECURITY,
    UNKNOWN,
}

sealed interface AuthOutcome<out Value> {
    data class Success<Value>(val value: Value) : AuthOutcome<Value>
    data class Failure(val kind: AuthFailureKind, val message: String) : AuthOutcome<Nothing>
}

/**
 * Executes an authenticated request without exposing or duplicating session storage.
 *
 * Implementations provide the short-lived Bearer only to the suspended call. Callers must use
 * it as an HTTP header and must never persist, log or expose it in UI state.
 */
internal interface AuthenticatedRequestExecutor {
    suspend fun <Value> executeAuthenticated(
        call: suspend (authorizationHeader: String) -> Value,
    ): AuthOutcome<Value>

    suspend fun invalidateAuthentication() = Unit
}

/**
 * Executes an endpoint that supports both guests and signed-in users.
 *
 * A null header is supplied only when no local session material exists. If a
 * stored session is expired, unreadable or cannot be refreshed, the failure is
 * returned and the request is never retried as a guest.
 */
internal interface OptionalAuthenticatedRequestExecutor {
    suspend fun <Value> execute(
        forceGuest: Boolean,
        call: suspend (authorizationHeader: String?) -> Value,
    ): AuthOutcome<OptionalAuthenticatedCallResult<Value>>

    suspend fun invalidateAuthentication(expectedGeneration: Long) = Unit
}

/**
 * Executes a signed-in-only request while binding its eventual response to the
 * authentication generation that supplied the Bearer token.
 *
 * A delayed 401 may therefore invalidate only that generation instead of
 * accidentally logging out a newer session established while the request was
 * in flight.
 */
internal interface GenerationAuthenticatedRequestExecutor {
    suspend fun <Value> execute(
        call: suspend (authorizationHeader: String) -> Value,
    ): AuthOutcome<AuthenticatedCallResult<Value>>

    suspend fun invalidateAuthentication(expectedGeneration: Long) = Unit

    suspend fun isAuthenticationCurrent(
        expectedGeneration: Long,
        expectedUserId: String,
        expectedSessionId: String,
    ): Boolean
}

internal data class AuthenticatedCallResult<Value>(
    val value: Value,
    val authenticationGeneration: Long,
    val userId: String,
    val sessionId: String,
)

internal data class OptionalAuthenticatedCallResult<Value>(
    val value: Value,
    val authenticationGeneration: Long?,
)

data class LocalAuthSession(
    val userId: String,
    val sessionId: String,
    val accessTokenExpiresAt: Instant,
    val refreshTokenExpiresAt: Instant,
)

@Singleton
class AuthRepository @Inject constructor(
    private val api: AuthApi,
    private val sessionStore: AuthSessionStore,
    private val privacyAuthorizationGate: PrivacyAuthorizationGate,
) : AccountAuthActions {
    internal constructor(
        api: AuthApi,
        sessionStore: AuthSessionStore,
    ) : this(api, sessionStore, AlwaysAcceptedPrivacyAuthorizationGate)

    private val mutex = Mutex()
    private val mutableSession = MutableStateFlow<LocalAuthSession?>(null)
    private var accessToken: String? = null
    private var authenticationGeneration = 0L
    private val authAttemptState = AtomicReference(
        AuthAttemptState(generation = 0L, privacyBlocked = false),
    )

    val session: StateFlow<LocalAuthSession?> = mutableSession.asStateFlow()

    /**
     * Linearization point for privacy withdrawal. This is intentionally
     * non-suspending: every in-flight login, registration or refresh lease is
     * revoked before the UI callback returns.
     */
    internal fun revokeAuthAttemptsForPrivacyWithdrawal() {
        advanceAuthAttemptState(privacyBlocked = true)
    }

    /** Re-opens authentication only after accepted consent has been persisted. */
    internal fun allowAuthAttemptsAfterPrivacyConsent() {
        advanceAuthAttemptState(privacyBlocked = false)
    }

    override suspend fun hasLocalSessionMaterial(): Boolean =
        mutableSession.value != null || sessionStore.hasSessionMaterial()

    override suspend fun restoreSession(): AuthOutcome<LocalAuthSession?> {
        if (!privacyAuthorizationGate.isAcceptedFailClosed()) return privacyBlockedFailure()
        if (privacyIsBlocked()) return privacyBlockedFailure()
        return mutex.withLock {
            if (privacyIsBlocked()) return@withLock privacyBlockedFailure()
            val current = mutableSession.value
            if (current != null && current.accessTokenExpiresAt.isAfter(Instant.now().plusSeconds(30))) {
                return@withLock AuthOutcome.Success(current)
            }
            restoreLocked()
        }
    }

    override suspend fun requestPhoneCode(
        rawPhone: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> {
        if (!privacyAuthorizationGate.isAcceptedFailClosed()) return privacyBlockedFailure()
        if (privacyIsBlocked()) return privacyBlockedFailure()
        if (purpose !in setOf(OtpPurpose.REGISTER, OtpPurpose.LOGIN)) {
            return invalidInput("手机号只支持注册或登录验证码")
        }
        val phone = normalizeMainlandPhone(rawPhone)
            ?: return invalidInput("请输入 11 位中国大陆手机号（也支持 +86 格式）")
        return remote {
            val authorization = otpAuthorizationHeader(purpose)
            val attempt = beginAuthAttempt() ?: throw AuthenticationAttemptInvalidated()
            val response = api.requestPhoneCode(
                authorization,
                PhoneCodeRequest(phone, purpose, sessionStore.installationId()),
            )
            if (!isAuthAttemptCurrent(attempt)) throw AuthenticationAttemptInvalidated()
            if (!AuthResponseValidator.validChallenge(response, AuthIdentityType.PHONE, Instant.now())) {
                throw InvalidAuthResponse()
            }
            response
        }
    }

    override suspend fun requestEmailCode(
        rawEmail: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> {
        if (!privacyAuthorizationGate.isAcceptedFailClosed()) return privacyBlockedFailure()
        if (privacyIsBlocked()) return privacyBlockedFailure()
        if (purpose !in setOf(OtpPurpose.LOGIN, OtpPurpose.BIND)) {
            return invalidInput("邮箱只支持登录或绑定验证码")
        }
        val email = rawEmail.trim().lowercase(Locale.ROOT)
        if (!email.matches(EMAIL) || email.length > 254) return invalidInput("请输入有效邮箱地址")
        return remote {
            val authorization = otpAuthorizationHeader(purpose)
            val attempt = beginAuthAttempt() ?: throw AuthenticationAttemptInvalidated()
            val response = api.requestEmailCode(
                authorization,
                EmailCodeRequest(email, purpose, sessionStore.installationId()),
            )
            if (!isAuthAttemptCurrent(attempt)) throw AuthenticationAttemptInvalidated()
            if (!AuthResponseValidator.validChallenge(response, AuthIdentityType.EMAIL, Instant.now())) {
                throw InvalidAuthResponse()
            }
            response
        }
    }

    override suspend fun createOAuthState(
        provider: AuthIdentityType,
        purpose: OAuthPurpose,
    ): AuthOutcome<OAuthStateResponse> {
        if (!privacyAuthorizationGate.isAcceptedFailClosed()) return privacyBlockedFailure()
        if (privacyIsBlocked()) return privacyBlockedFailure()
        val supportedPurpose = when (provider) {
            AuthIdentityType.WECHAT -> purpose in setOf(OAuthPurpose.LOGIN, OAuthPurpose.BIND)
            AuthIdentityType.QQ -> purpose in setOf(OAuthPurpose.LOGIN, OAuthPurpose.BIND)
            else -> false
        }
        if (!supportedPurpose) return invalidInput("该登录方式不支持当前 OAuth 用途")
        return remote {
            val authorization = if (purpose == OAuthPurpose.BIND) {
                authorizationHeaderLocked()
            } else {
                null
            }
            val attempt = beginAuthAttempt() ?: throw AuthenticationAttemptInvalidated()
            val response = api.createOAuthState(
                authorization,
                OAuthStateRequest(
                    provider = provider,
                    purpose = purpose,
                    installationId = sessionStore.installationId(),
                ),
            )
            if (!isAuthAttemptCurrent(attempt)) throw AuthenticationAttemptInvalidated()
            if (!AuthResponseValidator.validOAuthState(response, provider, purpose, Instant.now())) {
                throw InvalidAuthResponse()
            }
            response
        }
    }

    override suspend fun loginWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
        phoneNumber: String?,
    ): AuthOutcome<LocalAuthSession> {
        if (type !in setOf(AuthIdentityType.PHONE, AuthIdentityType.EMAIL) ||
            !validOtpProof(challengeId, otpCode)
        ) {
            return invalidInput("验证码登录参数无效")
        }
        val method = when (type) {
            AuthIdentityType.PHONE -> AuthLoginMethod.PHONE
            AuthIdentityType.EMAIL -> AuthLoginMethod.EMAIL
            else -> return invalidInput("验证码登录方式无效")
        }
        val normalizedPhone = phoneNumber?.let(::normalizeMainlandPhone)
        if (type == AuthIdentityType.PHONE && normalizedPhone == null) {
            return invalidInput("手机号验证码校验必须携带原手机号")
        }
        if (type != AuthIdentityType.PHONE && phoneNumber != null) {
            return invalidInput("非手机号验证码不能携带手机号")
        }
        return authenticate {
            api.login(
                AuthLoginRequest(
                    method = method,
                    challengeId = challengeId,
                    otpCode = otpCode,
                    phoneNumber = normalizedPhone,
                    device = deviceContext(),
                ),
            )
        }
    }

    override suspend fun loginWithWechat(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession> {
        if (!validOAuthProof(oauthState, authorizationCode)) return invalidInput("微信授权结果格式无效")
        return authenticate {
            api.login(
                AuthLoginRequest(
                    method = AuthLoginMethod.WECHAT,
                    oauthState = oauthState,
                    authorizationCode = authorizationCode,
                    device = deviceContext(),
                ),
            )
        }
    }

    override suspend fun loginWithQq(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession> {
        if (!validOAuthProof(oauthState, authorizationCode)) {
            return invalidInput("QQ 授权结果格式无效")
        }
        return authenticate {
            api.login(
                AuthLoginRequest(
                    method = AuthLoginMethod.QQ,
                    oauthState = oauthState,
                    authorizationCode = authorizationCode,
                    device = deviceContext(),
                ),
            )
        }
    }

    override suspend fun identities(): AuthOutcome<List<AuthIdentityBinding>> = authenticatedRemote { header ->
        val response: AuthIdentityBindingsResponse = api.identities(header)
        if (!AuthResponseValidator.validIdentities(response)) throw InvalidAuthResponse()
        response.items
    }

    override suspend fun bindWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
    ): AuthOutcome<AuthIdentityBinding> {
        if (type != AuthIdentityType.EMAIL ||
            !validOtpProof(challengeId, otpCode)
        ) {
            return invalidInput("绑定验证码参数无效")
        }
        return bindIdentity(
            BindIdentityRequest(
                type = type,
                challengeId = challengeId,
                otpCode = otpCode,
            ),
        )
    }

    override suspend fun bindWithQq(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<AuthIdentityBinding> {
        if (!validOAuthProof(oauthState, authorizationCode)) {
            return invalidInput("QQ 授权结果格式无效")
        }
        return bindIdentity(
            BindIdentityRequest(
                type = AuthIdentityType.QQ,
                oauthState = oauthState,
                authorizationCode = authorizationCode,
            ),
        )
    }

    override suspend fun bindWithWechat(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<AuthIdentityBinding> {
        if (!validOAuthProof(oauthState, authorizationCode)) {
            return invalidInput("微信授权结果格式无效")
        }
        return bindIdentity(
            BindIdentityRequest(
                type = AuthIdentityType.WECHAT,
                oauthState = oauthState,
                authorizationCode = authorizationCode,
            ),
        )
    }

    override suspend fun sessions(): AuthOutcome<List<AuthSessionSummary>> = authenticatedRemote { header ->
        val response: AuthSessionsResponse = api.sessions(header)
        if (!AuthResponseValidator.validSessions(response)) throw InvalidAuthResponse()
        response.items
    }

    override suspend fun unbindIdentity(bindingId: String): AuthOutcome<Unit> {
        if (!AuthResponseValidator.run { bindingId.isCanonicalUuid() }) return invalidInput("身份编号无效")
        return authenticatedRemote { header ->
            val response = api.unbindIdentity(header, bindingId)
            if (response.bindingId != bindingId || response.unboundAt.toInstantOrNull() == null) {
                throw InvalidAuthResponse()
            }
            Unit
        }
    }

    override suspend fun revokeSession(sessionId: String): AuthOutcome<Unit> {
        if (!AuthResponseValidator.run { sessionId.isCanonicalUuid() }) return invalidInput("设备会话编号无效")
        val outcome = authenticatedRemote { header ->
            val response = api.revokeSession(header, sessionId)
            if (response.sessionId != sessionId || response.revokedAt.toInstantOrNull() == null) {
                throw InvalidAuthResponse()
            }
            Unit
        }
        if (outcome is AuthOutcome.Success && mutableSession.value?.sessionId == sessionId) clearLocalSession()
        return outcome
    }

    override suspend fun deleteAccount(): AuthOutcome<DeleteAccountResponse> {
        val outcome = authenticatedRemote { header ->
            val response = api.deleteAccount(header, DeleteAccountRequest())
            val invalidatedAt = response.invalidatedAt.toInstantOrNull()
            val deadline = response.backupDeletionDeadline.toInstantOrNull()
            if (
                !AuthResponseValidator.run { response.deletionId.isCanonicalUuid() } ||
                !AuthResponseValidator.run { response.userId.isCanonicalUuid() } ||
                response.userId != mutableSession.value?.userId ||
                response.status != "DEACTIVATED" ||
                invalidatedAt == null ||
                deadline == null ||
                !deadline.isAfter(invalidatedAt) ||
                deadline > invalidatedAt.plusSeconds(30 * 24 * 60 * 60L)
            ) {
                throw InvalidAuthResponse()
            }
            response
        }
        if (outcome is AuthOutcome.Success) clearLocalSession()
        return outcome
    }

    override suspend fun logout(): AuthOutcome<Unit> {
        return try {
            val expectedSessionId = mutableSession.value?.sessionId
            val header = runCatching { authorizationHeaderLocked() }.getOrNull()
            if (header == null || expectedSessionId == null) {
                AuthOutcome.Success(Unit)
            } else {
                remote {
                    val response = api.logout(header)
                    if (
                        response.sessionId != expectedSessionId ||
                        response.loggedOutAt.toInstantOrNull() == null
                    ) {
                        throw InvalidAuthResponse()
                    }
                    Unit
                }
            }
        } finally {
            withContext(NonCancellable) { clearLocalSession() }
        }
    }

    suspend fun clearLocalSession() {
        // This increment deliberately happens before the suspending mutex
        // acquisition. A privacy withdrawal can therefore invalidate a
        // non-cooperative login/register response immediately, even while
        // that transport call is still in flight.
        invalidatePendingAuthAttempts()
        mutex.withLock {
            authenticationGeneration += 1
            accessToken = null
            mutableSession.value = null
            sessionStore.clear()
        }
    }

    internal suspend fun clearLocalSessionIfGeneration(expectedGeneration: Long) = mutex.withLock {
        clearLocalSessionIfGenerationLocked(expectedGeneration)
    }

    private suspend fun clearLocalSessionIfGenerationLocked(expectedGeneration: Long) {
        if (authenticationGeneration != expectedGeneration) return
        invalidatePendingAuthAttempts()
        authenticationGeneration += 1
        accessToken = null
        mutableSession.value = null
        sessionStore.clear()
    }

    internal suspend fun isLocalAuthenticationCurrent(
        expectedGeneration: Long,
        expectedUserId: String,
        expectedSessionId: String,
    ): Boolean = mutex.withLock {
        val current = mutableSession.value
        authenticationGeneration == expectedGeneration &&
            accessToken != null &&
            current != null &&
            current.userId == expectedUserId &&
            current.sessionId == expectedSessionId
    }

    private suspend fun authenticate(
        call: suspend () -> AuthTokenResponse,
    ): AuthOutcome<LocalAuthSession> {
        if (!privacyAuthorizationGate.isAcceptedFailClosed()) return privacyBlockedFailure()
        val attempt = beginAuthAttempt() ?: return privacyBlockedFailure()
        var response: AuthTokenResponse? = null
        var localGenerationBeforePersist: Long? = null
        return try {
            if (!isAuthAttemptCurrent(attempt)) throw AuthenticationAttemptInvalidated()
            val tokenResponse = call()
            response = tokenResponse
            mutex.withLock {
                val commit = claimAuthAttemptForCommit(attempt)
                    ?: throw AuthenticationAttemptInvalidated()
                localGenerationBeforePersist = authenticationGeneration
                persistTokensLocked(tokenResponse, commit = commit)
            }.let { session -> AuthOutcome.Success(session) }
        } catch (error: CancellationException) {
            val cancelledResponse = response
            if (
                cancelledResponse != null &&
                AuthResponseValidator.validTokens(cancelledResponse, Instant.now())
            ) {
                try {
                    compensateCancelledAuthentication(
                        response = cancelledResponse,
                        localGenerationBeforePersist = localGenerationBeforePersist,
                    )
                } catch (_: Exception) {
                    // Compensation can never replace the caller's cancellation.
                }
            }
            throw error
        } catch (error: Exception) {
            val staleResponse = response
            if (
                error is AuthenticationAttemptInvalidated &&
                staleResponse != null &&
                AuthResponseValidator.validTokens(staleResponse, Instant.now())
            ) {
                // The backend may already have created a session. Best-effort
                // revoke it without exposing or retaining the stale token.
                runCatching { api.logout("Bearer ${staleResponse.accessToken}") }
            }
            mapFailure(error)
        }
    }

    internal suspend fun <Value> executeAuthenticated(
        call: suspend (String) -> Value,
    ): AuthOutcome<Value> = remote {
        call(authorizationHeaderLocked())
    }

    internal suspend fun <Value> executeAuthenticatedWithGeneration(
        call: suspend (String) -> Value,
    ): AuthOutcome<AuthenticatedCallResult<Value>> = when (val authorization = optionalAuthorizationHeader()) {
        is AuthOutcome.Failure -> authorization
        is AuthOutcome.Success -> {
            val header = authorization.value.header
            val generation = authorization.value.authenticationGeneration
            val userId = authorization.value.userId
            val sessionId = authorization.value.sessionId
            if (header == null || generation == null || userId == null || sessionId == null) {
                AuthOutcome.Failure(AuthFailureKind.UNAUTHORIZED, "请先登录账号")
            } else {
                remote {
                    AuthenticatedCallResult(
                        value = call(header),
                        authenticationGeneration = generation,
                        userId = userId,
                        sessionId = sessionId,
                    )
                }
            }
        }
    }

    internal suspend fun <Value> executeOptionallyAuthenticated(
        forceGuest: Boolean,
        call: suspend (String?) -> Value,
    ): AuthOutcome<OptionalAuthenticatedCallResult<Value>> {
        if (forceGuest) {
            return remote {
                OptionalAuthenticatedCallResult(call(null), authenticationGeneration = null)
            }
        }
        return when (val authorization = optionalAuthorizationHeader()) {
            is AuthOutcome.Failure -> authorization
            is AuthOutcome.Success -> remote {
                OptionalAuthenticatedCallResult(
                    value = call(authorization.value.header),
                    authenticationGeneration = authorization.value.authenticationGeneration,
                )
            }
        }
    }

    private suspend fun <Value> authenticatedRemote(
        call: suspend (String) -> Value,
    ): AuthOutcome<Value> = executeAuthenticated(call)

    private suspend fun bindIdentity(request: BindIdentityRequest): AuthOutcome<AuthIdentityBinding> =
        authenticatedRemote { header ->
            val response = api.bindIdentity(header, request)
            if (
                !AuthResponseValidator.validIdentity(response.binding) ||
                response.binding.type != request.type
            ) {
                throw InvalidAuthResponse()
            }
            response.binding
        }

    private suspend fun authorizationHeaderLocked(): String {
        if (!privacyAuthorizationGate.isAcceptedFailClosed()) throw AuthenticationAttemptInvalidated()
        if (privacyIsBlocked()) throw AuthenticationAttemptInvalidated()
        return mutex.withLock {
            if (privacyIsBlocked()) throw AuthenticationAttemptInvalidated()
            val current = mutableSession.value
            if (current == null || current.accessTokenExpiresAt <= Instant.now().plusSeconds(30)) {
                when (val restored = restoreLocked()) {
                    is AuthOutcome.Success -> if (restored.value == null) throw MissingAuthentication()
                    is AuthOutcome.Failure -> throw RestoreSessionFailure(restored)
                }
            }
            if (privacyIsBlocked()) throw AuthenticationAttemptInvalidated()
            val token = accessToken ?: throw MissingAuthentication()
            "Bearer $token"
        }
    }

    private suspend fun optionalAuthorizationHeader(): AuthOutcome<OptionalAuthorization> {
        if (!privacyAuthorizationGate.isAcceptedFailClosed()) return privacyBlockedFailure()
        return mutex.withLock {
            if (privacyIsBlocked()) return@withLock privacyBlockedFailure()
            val current = mutableSession.value
            val currentToken = accessToken
            if (
                current != null &&
                currentToken != null &&
                current.accessTokenExpiresAt.isAfter(Instant.now().plusSeconds(30))
            ) {
                return@withLock AuthOutcome.Success(
                    OptionalAuthorization(
                        header = "Bearer $currentToken",
                        authenticationGeneration = authenticationGeneration,
                        userId = current.userId,
                        sessionId = current.sessionId,
                    ),
                )
            }

            val hadMemorySession = current != null || currentToken != null
            val hadStoredSession = try {
                sessionStore.hasSessionMaterial()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                return@withLock AuthOutcome.Failure(
                    AuthFailureKind.LOCAL_SECURITY,
                    "本机登录状态无法安全读取；本次不会降级为游客提交",
                )
            }

            when (val restored = restoreLocked()) {
                is AuthOutcome.Failure -> restored
                is AuthOutcome.Success -> {
                    val restoredSession = restored.value
                    if (restoredSession == null) {
                        if (hadMemorySession || hadStoredSession) {
                            AuthOutcome.Failure(
                                AuthFailureKind.UNAUTHORIZED,
                                "登录状态已过期或无法恢复；本次不会降级为游客提交",
                            )
                        } else {
                            AuthOutcome.Success(
                                OptionalAuthorization(
                                    header = null,
                                    authenticationGeneration = null,
                                    userId = null,
                                    sessionId = null,
                                ),
                            )
                        }
                    } else {
                        val restoredToken = accessToken
                        if (restoredToken == null) {
                            AuthOutcome.Failure(
                                AuthFailureKind.LOCAL_SECURITY,
                                "本机登录状态无法安全读取；本次不会降级为游客提交",
                            )
                        } else {
                            AuthOutcome.Success(
                                OptionalAuthorization(
                                    header = "Bearer $restoredToken",
                                    authenticationGeneration = authenticationGeneration,
                                    userId = restoredSession.userId,
                                    sessionId = restoredSession.sessionId,
                                ),
                            )
                        }
                    }
                }
            }
        }
    }

    private suspend fun restoreLocked(): AuthOutcome<LocalAuthSession?> {
        if (privacyIsBlocked()) return privacyBlockedFailure()
        val stored = try {
            sessionStore.load()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            clearMemoryLocked()
            return AuthOutcome.Failure(AuthFailureKind.LOCAL_SECURITY, "本机安全存储暂不可用，请重新登录")
        } ?: run {
            clearMemoryLocked()
            return AuthOutcome.Success(null)
        }
        if (!stored.refreshTokenExpiresAt.isAfter(Instant.now())) {
            sessionStore.clear()
            clearMemoryLocked()
            return AuthOutcome.Success(null)
        }
        val attempt = beginAuthAttempt() ?: return privacyBlockedFailure()
        var response: AuthTokenResponse? = null
        var localGenerationBeforePersist: Long? = null
        return try {
            val tokenResponse = api.refresh(RefreshSessionRequest(stored.refreshToken, stored.installationId))
            response = tokenResponse
            val commit = claimAuthAttemptForCommit(attempt)
                ?: throw AuthenticationAttemptInvalidated()
            localGenerationBeforePersist = authenticationGeneration
            val session = persistTokensLocked(
                response = tokenResponse,
                expectedUserId = stored.userId,
                expectedSessionId = stored.sessionId,
                commit = commit,
            )
            AuthOutcome.Success(session)
        } catch (error: CancellationException) {
            val cancelledResponse = response
            if (
                cancelledResponse != null &&
                AuthResponseValidator.validTokens(
                    cancelledResponse,
                    Instant.now(),
                    stored.userId,
                    stored.sessionId,
                )
            ) {
                try {
                    compensateCancelledAuthentication(
                        response = cancelledResponse,
                        localGenerationBeforePersist = localGenerationBeforePersist,
                        repositoryMutexHeld = true,
                    )
                } catch (_: Exception) {
                    // Compensation can never replace the caller's cancellation.
                }
            }
            throw error
        } catch (error: Exception) {
            if (error is HttpException && error.code() == 401) {
                sessionStore.clear()
                clearMemoryLocked()
            } else if (
                error is InvalidAuthResponse ||
                error is LocalAuthSecurityFailure ||
                error is AuthenticationAttemptInvalidated
            ) {
                sessionStore.clear()
                clearMemoryLocked()
            }
            mapFailure(error)
        }
    }

    private suspend fun persistTokensLocked(
        response: AuthTokenResponse,
        expectedUserId: String? = null,
        expectedSessionId: String? = null,
        commit: AuthCommitLease,
    ): LocalAuthSession {
        val now = Instant.now()
        if (!AuthResponseValidator.validTokens(response, now, expectedUserId, expectedSessionId)) {
            throw InvalidAuthResponse()
        }
        val local = LocalAuthSession(
            userId = response.userId,
            sessionId = response.sessionId,
            accessTokenExpiresAt = Instant.parse(response.accessTokenExpiresAt),
            refreshTokenExpiresAt = Instant.parse(response.refreshTokenExpiresAt),
        )
        if (!isAuthCommitCurrent(commit)) throw AuthenticationAttemptInvalidated()
        try {
            sessionStore.save(
                AuthSessionToPersist(
                    userId = response.userId,
                    sessionId = response.sessionId,
                    refreshToken = response.refreshToken,
                    refreshTokenExpiresAt = local.refreshTokenExpiresAt,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            runCatching { api.logout("Bearer ${response.accessToken}") }
            throw LocalAuthSecurityFailure()
        }
        if (!isAuthCommitCurrent(commit)) {
            sessionStore.clear()
            clearMemoryLocked()
            throw AuthenticationAttemptInvalidated()
        }
        accessToken = response.accessToken
        mutableSession.value = local
        authenticationGeneration += 1
        if (!isAuthCommitCurrent(commit)) {
            sessionStore.clear()
            clearMemoryLocked()
            throw AuthenticationAttemptInvalidated()
        }
        return local
    }

    /**
     * A cancelled caller must not strand a backend session or partially persisted refresh token.
     * Cleanup is deliberately bounded and cannot replace the caller's original cancellation.
     */
    private suspend fun compensateCancelledAuthentication(
        response: AuthTokenResponse,
        localGenerationBeforePersist: Long?,
        repositoryMutexHeld: Boolean = false,
    ) = withContext(NonCancellable) {
        if (localGenerationBeforePersist != null) {
            withTimeoutOrNull(CANCELLED_AUTH_CLEANUP_TIMEOUT_MILLIS) {
                try {
                    if (repositoryMutexHeld) {
                        clearLocalSessionIfGenerationLocked(localGenerationBeforePersist)
                    } else {
                        clearLocalSessionIfGeneration(localGenerationBeforePersist)
                    }
                } catch (_: Exception) {
                    // Best effort: memory is cleared before secure-storage deletion is attempted.
                }
            }
        }
        withTimeoutOrNull(CANCELLED_AUTH_CLEANUP_TIMEOUT_MILLIS) {
            try {
                api.logout("Bearer ${response.accessToken}")
            } catch (_: Exception) {
                // Best effort: cancellation propagation must not depend on network availability.
            }
        }
    }

    private suspend fun deviceContext(): AuthDeviceContext = AuthDeviceContext(
        installationId = sessionStore.installationId(),
        label = "Android 设备",
        appVersion = BuildConfig.VERSION_NAME.substringBefore('-'),
    )

    private suspend fun otpAuthorizationHeader(purpose: OtpPurpose): String? =
        if (otpPurposeRequiresAuthentication(purpose)) authorizationHeaderLocked() else null

    private fun clearMemoryLocked() {
        invalidatePendingAuthAttempts()
        authenticationGeneration += 1
        accessToken = null
        mutableSession.value = null
    }

    private fun beginAuthAttempt(): AuthAttemptLease? {
        while (true) {
            val current = authAttemptState.get()
            if (current.privacyBlocked) return null
            val next = current.copy(generation = current.generation + 1L)
            if (authAttemptState.compareAndSet(current, next)) {
                return AuthAttemptLease(next.generation)
            }
        }
    }

    private fun claimAuthAttemptForCommit(attempt: AuthAttemptLease): AuthCommitLease? {
        while (true) {
            val current = authAttemptState.get()
            if (current.privacyBlocked || current.generation != attempt.generation) return null
            val next = current.copy(generation = current.generation + 1L)
            if (authAttemptState.compareAndSet(current, next)) {
                return AuthCommitLease(next.generation)
            }
        }
    }

    private fun isAuthAttemptCurrent(attempt: AuthAttemptLease): Boolean {
        val current = authAttemptState.get()
        return !current.privacyBlocked && current.generation == attempt.generation
    }

    private fun isAuthCommitCurrent(commit: AuthCommitLease): Boolean {
        val current = authAttemptState.get()
        return !current.privacyBlocked && current.generation == commit.generation
    }

    private fun invalidatePendingAuthAttempts() {
        while (true) {
            val current = authAttemptState.get()
            val next = current.copy(generation = current.generation + 1L)
            if (authAttemptState.compareAndSet(current, next)) return
        }
    }

    private fun advanceAuthAttemptState(privacyBlocked: Boolean) {
        while (true) {
            val current = authAttemptState.get()
            val next = AuthAttemptState(
                generation = current.generation + 1L,
                privacyBlocked = privacyBlocked,
            )
            if (authAttemptState.compareAndSet(current, next)) return
        }
    }

    private fun privacyIsBlocked(): Boolean = authAttemptState.get().privacyBlocked

    private suspend fun <Value> remote(call: suspend () -> Value): AuthOutcome<Value> = try {
        AuthOutcome.Success(call())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        mapFailure(error)
    }

    private fun mapFailure(error: Exception): AuthOutcome.Failure {
        if (error.hasIncompatibleApiContractCause()) {
            return AuthOutcome.Failure(AuthFailureKind.INCOMPATIBLE_API, "账号服务版本不兼容，请更新 App")
        }
        return when (error) {
            is MissingAuthentication -> AuthOutcome.Failure(AuthFailureKind.UNAUTHORIZED, "请先登录账号")
            is RestoreSessionFailure -> error.failure
            is AuthenticationAttemptInvalidated ->
                AuthOutcome.Failure(AuthFailureKind.UNAUTHORIZED, "登录流程已失效，请重新发起")
            is InvalidAuthResponse -> AuthOutcome.Failure(AuthFailureKind.INVALID_RESPONSE, "账号服务响应未通过安全校验")
            is LocalAuthSecurityFailure -> AuthOutcome.Failure(AuthFailureKind.LOCAL_SECURITY, "无法安全保存登录状态，请重新尝试")
            is UnknownHostException -> AuthOutcome.Failure(AuthFailureKind.NETWORK, "网络不可用，请检查连接")
            is SocketTimeoutException -> AuthOutcome.Failure(AuthFailureKind.TIMEOUT, "账号服务响应较慢，请稍后重试")
            is SerializationException -> AuthOutcome.Failure(AuthFailureKind.INVALID_RESPONSE, "账号服务响应无法识别")
            is HttpException -> mapAuthHttpFailure(error)
            else -> AuthOutcome.Failure(AuthFailureKind.UNKNOWN, "账号操作暂时失败，请重试")
        }
    }

    private fun <Value> invalidInput(message: String): AuthOutcome<Value> =
        AuthOutcome.Failure(AuthFailureKind.INPUT, message)

    private fun <Value> privacyBlockedFailure(): AuthOutcome<Value> =
        AuthOutcome.Failure(AuthFailureKind.FORBIDDEN, "隐私同意已撤回，请重新同意后再使用账号功能")

    private fun validOtpProof(challengeId: String, otpCode: String): Boolean =
        AuthResponseValidator.run { challengeId.isCanonicalUuid() } && otpCode.matches(OTP)

    private fun validOAuthProof(state: String, credential: String): Boolean =
        state.matches(OPAQUE_TOKEN) &&
            credential.length in 8..2_048 &&
            credential.matches(SAFE_EXTERNAL_CREDENTIAL)

    private fun String.toInstantOrNull(): Instant? = runCatching(Instant::parse).getOrNull()

    private class InvalidAuthResponse : Exception()
    private class AuthenticationAttemptInvalidated : Exception()
    private class MissingAuthentication : Exception()
    private class LocalAuthSecurityFailure : Exception()
    private class RestoreSessionFailure(val failure: AuthOutcome.Failure) : Exception()

    private data class OptionalAuthorization(
        val header: String?,
        val authenticationGeneration: Long?,
        val userId: String?,
        val sessionId: String?,
    )

    private data class AuthAttemptState(
        val generation: Long,
        val privacyBlocked: Boolean,
    )

    private data class AuthAttemptLease(val generation: Long)

    private data class AuthCommitLease(val generation: Long)

    private companion object {
        val MAINLAND_PHONE = Regex("^\\+861[3-9]\\d{9}$")
        val LOCAL_MAINLAND_PHONE = Regex("^1[3-9]\\d{9}$")
        val EMAIL = Regex("^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$")
        val OTP = Regex("^\\d{6}$")
        val OPAQUE_TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
        val SAFE_EXTERNAL_CREDENTIAL = Regex("^[A-Za-z0-9._~+/=-]+$")
        const val CANCELLED_AUTH_CLEANUP_TIMEOUT_MILLIS = 1_000L
    }

    private fun normalizeMainlandPhone(rawPhone: String): String? {
        val phone = rawPhone.trim()
        return when {
            phone.matches(MAINLAND_PHONE) -> phone
            phone.matches(LOCAL_MAINLAND_PHONE) -> "+86$phone"
            else -> null
        }
    }
}

internal fun mapAuthHttpFailure(error: HttpException): AuthOutcome.Failure = when (error.code()) {
    400 -> AuthOutcome.Failure(AuthFailureKind.INPUT, "提交的信息不符合要求")
    401 -> if (error.boundedAuthErrorCode() == "IDENTITY_NOT_BOUND") {
        AuthOutcome.Failure(
            AuthFailureKind.UNAUTHORIZED,
            "该登录身份尚未绑定账号，请先用手机号登录后完成绑定",
        )
    } else {
        AuthOutcome.Failure(AuthFailureKind.UNAUTHORIZED, "验证码、授权或登录状态无效")
    }
    403 -> AuthOutcome.Failure(AuthFailureKind.FORBIDDEN, "当前账号或设备不允许此操作")
    409 -> AuthOutcome.Failure(AuthFailureKind.CONFLICT, "身份已绑定其他账号或验证流程已使用")
    429 -> AuthOutcome.Failure(AuthFailureKind.RATE_LIMITED, "操作过于频繁，请稍后重试")
    503 -> AuthOutcome.Failure(AuthFailureKind.UNAVAILABLE, "该账号能力暂未开放或暂时不可用")
    else -> AuthOutcome.Failure(AuthFailureKind.UNKNOWN, "账号服务暂时不可用")
}

private fun HttpException.boundedAuthErrorCode(): String? {
    val body = response()?.errorBody() ?: return null
    return try {
        body.use { errorBody ->
            val declaredLength = errorBody.contentLength()
            if (declaredLength > MAX_AUTH_ERROR_BYTES || declaredLength < -1L) return null
            val source = errorBody.source()
            source.request(MAX_AUTH_ERROR_BYTES + 1L)
            if (source.buffer.size > MAX_AUTH_ERROR_BYTES) return null
            val bytes = source.buffer.clone().readByteArray()
            val raw = StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
            val parsed = STRICT_AUTH_ERROR_JSON.decodeFromString<AuthErrorResponse>(raw)
            if (AuthResponseValidator.run { parsed.requestId.isCanonicalUuid() }) {
                parsed.code
            } else {
                null
            }
        }
    } catch (_: Exception) {
        null
    }
}

private const val MAX_AUTH_ERROR_BYTES = 4L * 1_024L
private val STRICT_AUTH_ERROR_JSON = Json {
    ignoreUnknownKeys = false
    isLenient = false
}

internal fun otpPurposeRequiresAuthentication(purpose: OtpPurpose): Boolean =
    purpose == OtpPurpose.BIND

private object AlwaysAcceptedPrivacyAuthorizationGate : PrivacyAuthorizationGate {
    override suspend fun isAccepted(): Boolean = true

    override fun revoke() = Unit

    override fun allowAfterDurableAcceptance(): Boolean = true
}

private suspend fun PrivacyAuthorizationGate.isAcceptedFailClosed(): Boolean = try {
    isAccepted()
} catch (error: CancellationException) {
    throw error
} catch (_: Exception) {
    false
}
