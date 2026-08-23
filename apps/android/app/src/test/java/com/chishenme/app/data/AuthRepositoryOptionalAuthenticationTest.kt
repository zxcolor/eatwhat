package com.chishenme.app.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import com.chishenme.app.data.local.AuthSessionStore
import com.chishenme.app.data.local.AuthSessionToPersist
import com.chishenme.app.data.local.RefreshTokenCipher
import com.chishenme.app.data.remote.AuthApi
import com.chishenme.app.data.remote.AuthCodeChallenge
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthTokenResponse
import com.chishenme.app.data.remote.DeleteAccountResponse
import com.chishenme.app.data.remote.OAuthPurpose
import com.chishenme.app.data.remote.OAuthStateResponse
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import java.lang.reflect.Proxy
import java.time.Instant
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthRepositoryOptionalAuthenticationTest {
    @Test
    fun `unsupported Android 1_0 identity purposes fail before transport`() = runTest {
        var calls = 0
        val api = Proxy.newProxyInstance(
            AuthApi::class.java.classLoader,
            arrayOf(AuthApi::class.java),
        ) { _, method, _ ->
            calls += 1
            error("Unexpected AuthApi call: ${method.name}")
        } as AuthApi
        val repository = AuthRepository(api, store())
        val challengeId = "44444444-4444-4444-8444-444444444444"

        val phoneBind = repository.requestPhoneCode("+8613800138000", com.chishenme.app.data.remote.OtpPurpose.BIND)
        val emailRegister = repository.requestEmailCode(
            "user@example.com",
            com.chishenme.app.data.remote.OtpPurpose.REGISTER,
        )
        val wechatBind = repository.createOAuthState(
            AuthIdentityType.WECHAT,
            com.chishenme.app.data.remote.OAuthPurpose.BIND,
            phoneChallengeId = null,
        )
        val qqRegister = repository.createOAuthState(
            AuthIdentityType.QQ,
            com.chishenme.app.data.remote.OAuthPurpose.REGISTER,
            phoneChallengeId = challengeId,
        )
        val phoneIdentityBind = repository.bindWithOtp(
            AuthIdentityType.PHONE,
            challengeId,
            "123456",
        )

        listOf(phoneBind, emailRegister, wechatBind, qqRegister, phoneIdentityBind).forEach {
            assertTrue(it is AuthOutcome.Failure)
        }
        assertEquals(0, calls)
    }

    @Test
    fun `privacy withdrawal blocks new authentication before transport`() = runTest {
        var loginCalls = 0
        val api = Proxy.newProxyInstance(
            AuthApi::class.java.classLoader,
            arrayOf(AuthApi::class.java),
        ) { _, method, _ ->
            if (method.name == "login") loginCalls += 1
            error("Unexpected AuthApi call: ${method.name}")
        } as AuthApi
        val repository = AuthRepository(api, store())

        repository.revokeAuthAttemptsForPrivacyWithdrawal()
        val outcome = repository.loginWithOtp(
            AuthIdentityType.PHONE,
            "44444444-4444-4444-8444-444444444444",
            "123456",
        )

        assertEquals(AuthFailureKind.FORBIDDEN, (outcome as AuthOutcome.Failure).kind)
        assertEquals(0, loginCalls)
        assertNull(repository.session.value)
    }

    @Test
    fun `durable privacy gate blocks repository reconstruction before any transport`() = runTest {
        var calls = 0
        val api = Proxy.newProxyInstance(
            AuthApi::class.java.classLoader,
            arrayOf(AuthApi::class.java),
        ) { _, method, _ ->
            calls += 1
            error("Unexpected AuthApi call: ${method.name}")
        } as AuthApi
        val gate = object : PrivacyAuthorizationGate {
            override suspend fun isAccepted(): Boolean = false
            override fun revoke() = Unit
            override fun allowAfterDurableAcceptance(): Boolean = false
        }
        val repository = AuthRepository(api, store(), gate)

        val restore = repository.restoreSession()
        val login = repository.loginWithOtp(
            AuthIdentityType.PHONE,
            "44444444-4444-4444-8444-444444444444",
            "123456",
        )
        val oauth = repository.createOAuthState(
            AuthIdentityType.WECHAT,
            OAuthPurpose.LOGIN,
            phoneChallengeId = null,
        )

        listOf(restore, login, oauth).forEach { outcome ->
            assertEquals(AuthFailureKind.FORBIDDEN, (outcome as AuthOutcome.Failure).kind)
        }
        assertEquals(0, calls)
        assertNull(repository.session.value)
    }

    @Test
    fun `late phone and email challenge responses are rejected after privacy withdrawal`() = runTest {
        for (type in listOf(AuthIdentityType.PHONE, AuthIdentityType.EMAIL)) {
            val started = CompletableDeferred<Unit>()
            var continuation: Continuation<AuthCodeChallenge>? = null
            val api = Proxy.newProxyInstance(
                AuthApi::class.java.classLoader,
                arrayOf(AuthApi::class.java),
            ) { _, method, arguments ->
                val expectedMethod = if (type == AuthIdentityType.PHONE) {
                    "requestPhoneCode"
                } else {
                    "requestEmailCode"
                }
                if (method.name != expectedMethod) error("Unexpected AuthApi call: ${method.name}")
                @Suppress("UNCHECKED_CAST")
                continuation = arguments?.last() as Continuation<AuthCodeChallenge>
                started.complete(Unit)
                COROUTINE_SUSPENDED
            } as AuthApi
            val repository = AuthRepository(api, store())
            val request = async {
                if (type == AuthIdentityType.PHONE) {
                    repository.requestPhoneCode("+8613800138000", OtpPurpose.LOGIN)
                } else {
                    repository.requestEmailCode("User@Example.com", OtpPurpose.LOGIN)
                }
            }

            started.await()
            repository.revokeAuthAttemptsForPrivacyWithdrawal()
            val now = Instant.now()
            continuation?.resume(
                AuthCodeChallenge(
                    challengeId = "44444444-4444-4444-8444-444444444444",
                    targetType = type,
                    maskedTarget = if (type == AuthIdentityType.PHONE) {
                        "+86138****8000"
                    } else {
                        "u****r@example.com"
                    },
                    expiresAt = now.plusSeconds(300).toString(),
                    resendAvailableAt = now.plusSeconds(60).toString(),
                ),
            ) ?: error("challenge continuation missing")

            val outcome = request.await()
            assertEquals(AuthFailureKind.UNAUTHORIZED, (outcome as AuthOutcome.Failure).kind)
            assertNull(repository.session.value)
        }
    }

    @Test
    fun `late OAuth state response after privacy withdrawal cannot launch a provider flow`() = runTest {
        val started = CompletableDeferred<Unit>()
        var continuation: Continuation<OAuthStateResponse>? = null
        val api = Proxy.newProxyInstance(
            AuthApi::class.java.classLoader,
            arrayOf(AuthApi::class.java),
        ) { _, method, arguments ->
            if (method.name != "createOAuthState") error("Unexpected AuthApi call: ${method.name}")
            @Suppress("UNCHECKED_CAST")
            continuation = arguments?.last() as Continuation<OAuthStateResponse>
            started.complete(Unit)
            COROUTINE_SUSPENDED
        } as AuthApi
        val repository = AuthRepository(api, store())
        val request = async {
            repository.createOAuthState(
                AuthIdentityType.WECHAT,
                OAuthPurpose.LOGIN,
                phoneChallengeId = null,
            )
        }

        started.await()
        repository.revokeAuthAttemptsForPrivacyWithdrawal()
        continuation?.resume(
            OAuthStateResponse(
                provider = AuthIdentityType.WECHAT,
                purpose = OAuthPurpose.LOGIN,
                state = "s".repeat(43),
                expiresAt = Instant.now().plusSeconds(300).toString(),
            ),
        ) ?: error("OAuth state continuation missing")

        val outcome = request.await()
        assertEquals(AuthFailureKind.UNAUTHORIZED, (outcome as AuthOutcome.Failure).kind)
        assertNull(repository.session.value)
    }

    @Test
    fun `late login response after privacy withdrawal cannot rewrite secure session`() = runTest {
        val started = CompletableDeferred<Unit>()
        var continuation: Continuation<AuthTokenResponse>? = null
        var logoutCalls = 0
        val userId = "11111111-1111-4111-8111-111111111111"
        val sessionId = "22222222-2222-4222-8222-222222222222"
        val api = Proxy.newProxyInstance(
            AuthApi::class.java.classLoader,
            arrayOf(AuthApi::class.java),
        ) { _, method, arguments ->
            when (method.name) {
                "login" -> {
                    @Suppress("UNCHECKED_CAST")
                    continuation = arguments?.last() as Continuation<AuthTokenResponse>
                    started.complete(Unit)
                    COROUTINE_SUSPENDED
                }
                "logout" -> {
                    logoutCalls += 1
                    com.chishenme.app.data.remote.LogoutResponse(
                        sessionId = sessionId,
                        loggedOutAt = Instant.now().toString(),
                    )
                }
                else -> error("Unexpected AuthApi call: ${method.name}")
            }
        } as AuthApi
        val store = store()
        val repository = AuthRepository(api, store)
        val login = async {
            repository.loginWithOtp(
                AuthIdentityType.PHONE,
                "44444444-4444-4444-8444-444444444444",
                "123456",
            )
        }

        started.await()
        repository.revokeAuthAttemptsForPrivacyWithdrawal()
        repository.clearLocalSession()
        continuation?.resume(tokens(userId, sessionId, "a", "b"))
            ?: error("login continuation missing")
        val outcome = login.await()

        assertEquals(AuthFailureKind.UNAUTHORIZED, (outcome as AuthOutcome.Failure).kind)
        assertNull(repository.session.value)
        assertTrue(!store.hasSessionMaterial())
        assertEquals(1, logoutCalls)
    }

    @Test
    fun `persisted consent reopens only new authentication attempts`() = runTest {
        var loginCalls = 0
        val userId = "11111111-1111-4111-8111-111111111111"
        val sessionId = "22222222-2222-4222-8222-222222222222"
        val api = Proxy.newProxyInstance(
            AuthApi::class.java.classLoader,
            arrayOf(AuthApi::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "login" -> {
                    loginCalls += 1
                    tokens(userId, sessionId, "a", "b")
                }
                else -> error("Unexpected AuthApi call: ${method.name}")
            }
        } as AuthApi
        val repository = AuthRepository(api, store())
        repository.revokeAuthAttemptsForPrivacyWithdrawal()

        val blocked = repository.loginWithOtp(
            AuthIdentityType.PHONE,
            "44444444-4444-4444-8444-444444444444",
            "123456",
        )
        repository.allowAuthAttemptsAfterPrivacyConsent()
        val allowed = repository.loginWithOtp(
            AuthIdentityType.PHONE,
            "44444444-4444-4444-8444-444444444444",
            "123456",
        )

        assertEquals(AuthFailureKind.FORBIDDEN, (blocked as AuthOutcome.Failure).kind)
        assertTrue(allowed is AuthOutcome.Success)
        assertEquals(1, loginCalls)
        assertEquals(sessionId, repository.session.value?.sessionId)
    }

    @Test
    fun `stored refresh material can refresh then exercise account deletion right`() = runTest {
        val store = store()
        val userId = "11111111-1111-4111-8111-111111111111"
        val sessionId = "22222222-2222-4222-8222-222222222222"
        store.installationId()
        store.save(
            AuthSessionToPersist(
                userId = userId,
                sessionId = sessionId,
                refreshToken = "r".repeat(43),
                refreshTokenExpiresAt = Instant.now().plusSeconds(86_400),
            ),
        )
        val calls = mutableListOf<String>()
        val api = Proxy.newProxyInstance(
            AuthApi::class.java.classLoader,
            arrayOf(AuthApi::class.java),
        ) { _, method, _ ->
            calls += method.name
            when (method.name) {
                "refresh" -> tokens(userId, sessionId, "a", "b")
                "deleteAccount" -> DeleteAccountResponse(
                    deletionId = "33333333-3333-4333-8333-333333333333",
                    userId = userId,
                    status = "DEACTIVATED",
                    invalidatedAt = "2026-08-21T08:00:00Z",
                    backupDeletionDeadline = "2026-09-20T08:00:00Z",
                )
                else -> error("Unexpected AuthApi call: ${method.name}")
            }
        } as AuthApi
        val repository = AuthRepository(api, store)

        val outcome = repository.deleteAccount()

        assertTrue(outcome is AuthOutcome.Success)
        assertEquals(listOf("refresh", "deleteAccount"), calls)
        assertNull(repository.session.value)
        assertTrue(!store.hasSessionMaterial())
    }

    @Test
    fun `signed-in-only generation executor never calls transport as a guest`() = runTest {
        val repository = AuthRepository(unusedAuthApi(), store())
        var calls = 0

        val outcome = repository.executeAuthenticatedWithGeneration { _ ->
            calls += 1
            "must-not-run"
        }

        assertEquals(AuthFailureKind.UNAUTHORIZED, (outcome as AuthOutcome.Failure).kind)
        assertEquals(0, calls)
    }

    @Test
    fun `true empty installation may use guest transport`() = runTest {
        val repository = AuthRepository(unusedAuthApi(), store())
        var captured: String? = "not-called"

        val outcome = repository.executeOptionallyAuthenticated(forceGuest = false) { header ->
            captured = header
            "ok"
        }

        assertEquals("ok", (outcome as AuthOutcome.Success).value.value)
        assertNull(outcome.value.authenticationGeneration)
        assertNull(captured)
    }

    @Test
    fun `expired stored session is never downgraded to guest`() = runTest {
        val store = store()
        store.installationId()
        store.save(
            AuthSessionToPersist(
                userId = "11111111-1111-4111-8111-111111111111",
                sessionId = "22222222-2222-4222-8222-222222222222",
                refreshToken = "r".repeat(43),
                refreshTokenExpiresAt = Instant.parse("2020-01-01T00:00:00Z"),
            ),
        )
        val repository = AuthRepository(unusedAuthApi(), store)
        var calls = 0

        val outcome = repository.executeOptionallyAuthenticated(forceGuest = false) { _ ->
            calls += 1
            "must-not-run"
        }

        val failure = outcome as AuthOutcome.Failure
        assertEquals(AuthFailureKind.UNAUTHORIZED, failure.kind)
        assertTrue(failure.message.contains("不会降级"))
        assertEquals(0, calls)
    }

    @Test
    fun `stale authentication generation cannot clear a newer login`() = runTest {
        val store = store()
        val userId = "11111111-1111-4111-8111-111111111111"
        val firstSessionId = "22222222-2222-4222-8222-222222222222"
        val secondSessionId = "33333333-3333-4333-8333-333333333333"
        store.installationId()
        store.save(
            AuthSessionToPersist(
                userId = userId,
                sessionId = firstSessionId,
                refreshToken = "r".repeat(43),
                refreshTokenExpiresAt = Instant.now().plusSeconds(86_400),
            ),
        )
        val repository = AuthRepository(
            rotatingAuthApi(userId, firstSessionId, secondSessionId),
            store,
        )
        val first = repository.executeOptionallyAuthenticated(forceGuest = false) { "sent" }
        val firstValue = (first as AuthOutcome.Success<*>).value
            as OptionalAuthenticatedCallResult<*>
        val staleGeneration = firstValue.authenticationGeneration ?: error("missing generation")

        val login = repository.loginWithOtp(
            AuthIdentityType.PHONE,
            "44444444-4444-4444-8444-444444444444",
            "123456",
        )
        assertTrue(login is AuthOutcome.Success)
        assertEquals(secondSessionId, repository.session.value?.sessionId)

        repository.clearLocalSessionIfGeneration(staleGeneration)

        assertEquals(secondSessionId, repository.session.value?.sessionId)
    }

    @Test
    fun `captured generation and session stop being current after account session switch`() = runTest {
        val store = store()
        val userId = "11111111-1111-4111-8111-111111111111"
        val firstSessionId = "22222222-2222-4222-8222-222222222222"
        val secondSessionId = "33333333-3333-4333-8333-333333333333"
        store.installationId()
        store.save(
            AuthSessionToPersist(
                userId = userId,
                sessionId = firstSessionId,
                refreshToken = "r".repeat(43),
                refreshTokenExpiresAt = Instant.now().plusSeconds(86_400),
            ),
        )
        val repository = AuthRepository(
            rotatingAuthApi(userId, firstSessionId, secondSessionId),
            store,
        )
        val capturedOutcome = repository.executeAuthenticatedWithGeneration { "sent" }
        val captured = (capturedOutcome as AuthOutcome.Success<AuthenticatedCallResult<String>>).value

        assertTrue(
            repository.isLocalAuthenticationCurrent(
                captured.authenticationGeneration,
                captured.userId,
                captured.sessionId,
            ),
        )

        assertTrue(
            repository.loginWithOtp(
                AuthIdentityType.PHONE,
                "44444444-4444-4444-8444-444444444444",
                "123456",
            ) is AuthOutcome.Success,
        )
        assertTrue(
            !repository.isLocalAuthenticationCurrent(
                captured.authenticationGeneration,
                captured.userId,
                captured.sessionId,
            ),
        )
        assertEquals(secondSessionId, repository.session.value?.sessionId)
    }

    private fun store(): AuthSessionStore = AuthSessionStore(InMemoryDataStore(), ReversibleCipher())

    private fun unusedAuthApi(): AuthApi = Proxy.newProxyInstance(
        AuthApi::class.java.classLoader,
        arrayOf(AuthApi::class.java),
    ) { _, method, _ -> error("Unexpected AuthApi call: ${method.name}") } as AuthApi

    private fun rotatingAuthApi(
        userId: String,
        firstSessionId: String,
        secondSessionId: String,
    ): AuthApi = Proxy.newProxyInstance(
        AuthApi::class.java.classLoader,
        arrayOf(AuthApi::class.java),
    ) { _, method, _ ->
        when (method.name) {
            "refresh" -> tokens(userId, firstSessionId, "a", "b")
            "login" -> tokens(userId, secondSessionId, "c", "d")
            else -> error("Unexpected AuthApi call: ${method.name}")
        }
    } as AuthApi

    private fun tokens(
        userId: String,
        sessionId: String,
        accessCharacter: String,
        refreshCharacter: String,
    ): AuthTokenResponse {
        val now = Instant.now()
        return AuthTokenResponse(
            userId = userId,
            sessionId = sessionId,
            tokenType = "Bearer",
            accessToken = accessCharacter.repeat(43),
            accessTokenExpiresAt = now.plusSeconds(600).toString(),
            refreshToken = refreshCharacter.repeat(43),
            refreshTokenExpiresAt = now.plusSeconds(86_400).toString(),
        )
    }

    private class ReversibleCipher : RefreshTokenCipher {
        private val values = mutableMapOf<String, String>()

        override fun encrypt(plaintext: String, associatedData: ByteArray): String {
            val envelope = "test-envelope"
            values[envelope + associatedData.decodeToString()] = plaintext
            return envelope
        }

        override fun decrypt(envelope: String, associatedData: ByteArray): String =
            values[envelope + associatedData.decodeToString()] ?: error("missing test value")

        override fun deleteKey() {
            values.clear()
        }
    }

    private class InMemoryDataStore : DataStore<Preferences> {
        private val state = MutableStateFlow<Preferences>(emptyPreferences())
        override val data: Flow<Preferences> = state

        override suspend fun updateData(
            transform: suspend (Preferences) -> Preferences,
        ): Preferences = transform(state.value).also { state.value = it }
    }
}
