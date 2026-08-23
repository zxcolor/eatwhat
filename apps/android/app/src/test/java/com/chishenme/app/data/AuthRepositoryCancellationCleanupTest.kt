package com.chishenme.app.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import com.chishenme.app.data.local.AuthPreferenceKeys
import com.chishenme.app.data.local.AuthSessionStore
import com.chishenme.app.data.local.AuthSessionToPersist
import com.chishenme.app.data.local.RefreshTokenCipher
import com.chishenme.app.data.remote.AuthApi
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthTokenResponse
import com.chishenme.app.data.remote.LogoutResponse
import java.lang.reflect.Proxy
import java.time.Instant
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED
import kotlin.coroutines.startCoroutine
import kotlin.system.measureTimeMillis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AuthRepositoryCancellationCleanupTest {
    @Test
    fun `cancelled secure save revokes backend session clears partial material and rethrows original cancellation`() =
        runBlocking {
            val cancellation = CancellationException("screen closed while saving authenticated session")
            val dataStore = CancellingSessionWriteDataStore(cancellation)
            val sessionStore = AuthSessionStore(dataStore, ReversibleCipher())
            val response = tokens()
            val logoutHeaders = mutableListOf<String>()
            val repository = AuthRepository(
                authApi(
                    response = response,
                    logout = { header, _ ->
                        logoutHeaders += header
                        LogoutResponse(response.sessionId, Instant.now().toString())
                    },
                ),
                sessionStore,
            )

            val thrown = captureCancellation {
                repository.loginWithOtp(
                    AuthIdentityType.PHONE,
                    CHALLENGE_ID,
                    "123456",
                )
            }

            assertSame(cancellation, thrown)
            assertEquals(listOf("Bearer ${response.accessToken}"), logoutHeaders)
            assertNull(repository.session.value)
            assertTrue(!sessionStore.hasSessionMaterial())
        }

    @Test
    fun `hung compensation logout is bounded and cannot replace the original cancellation`() = runBlocking {
        val cancellation = CancellationException("caller cancelled during secure save")
        val dataStore = CancellingSessionWriteDataStore(cancellation)
        val sessionStore = AuthSessionStore(dataStore, ReversibleCipher())
        val response = tokens()
        val logoutHeaders = mutableListOf<String>()
        val repository = AuthRepository(
            authApi(
                response = response,
                logout = { header, continuation ->
                    logoutHeaders += header
                    val neverCompletes: suspend () -> LogoutResponse = { awaitCancellation() }
                    neverCompletes.startCoroutine(continuation)
                    COROUTINE_SUSPENDED
                },
            ),
            sessionStore,
        )

        var thrown: CancellationException? = null
        val elapsedMillis = measureTimeMillis {
            thrown = captureCancellation {
                repository.loginWithOtp(
                    AuthIdentityType.EMAIL,
                    CHALLENGE_ID,
                    "123456",
                )
            }
        }

        assertSame(cancellation, thrown)
        assertEquals(listOf("Bearer ${response.accessToken}"), logoutHeaders)
        assertTrue(
            "hung cleanup must return near its one-second network ceiling; elapsed=$elapsedMillis",
            elapsedMillis in 800L..4_000L,
        )
        assertNull(repository.session.value)
        assertTrue(!sessionStore.hasSessionMaterial())
    }

    @Test
    fun `cancelled refresh uses the same bounded compensation and removes partial replacement`() = runBlocking {
        val cancellation = CancellationException("screen closed while refreshing session")
        val dataStore = CancellingSessionWriteDataStore(cancellation, armedInitially = false)
        val sessionStore = AuthSessionStore(dataStore, ReversibleCipher())
        val response = tokens()
        sessionStore.installationId()
        sessionStore.save(
            AuthSessionToPersist(
                userId = response.userId,
                sessionId = response.sessionId,
                refreshToken = "s".repeat(43),
                refreshTokenExpiresAt = Instant.now().plusSeconds(86_400),
            ),
        )
        dataStore.arm()
        val logoutHeaders = mutableListOf<String>()
        val repository = AuthRepository(
            authApi(
                response = response,
                logout = { header, _ ->
                    logoutHeaders += header
                    LogoutResponse(response.sessionId, Instant.now().toString())
                },
            ),
            sessionStore,
        )

        val thrown = captureCancellation { repository.restoreSession() }

        assertSame(cancellation, thrown)
        assertEquals(listOf("Bearer ${response.accessToken}"), logoutHeaders)
        assertNull(repository.session.value)
        assertTrue(!sessionStore.hasSessionMaterial())
    }

    @Test
    fun `cleanup cancellation never replaces the caller cancellation`() = runBlocking {
        val callerCancellation = CancellationException("caller cancellation")
        val cleanupCancellation = CancellationException("secure cleanup cancellation")
        val dataStore = CancellingSessionWriteDataStore(
            cancellation = callerCancellation,
            cleanupCancellation = cleanupCancellation,
        )
        val sessionStore = AuthSessionStore(dataStore, ReversibleCipher())
        val response = tokens()
        val repository = AuthRepository(
            authApi(
                response = response,
                logout = { _, _ -> throw CancellationException("logout cancellation") },
            ),
            sessionStore,
        )

        val thrown = captureCancellation {
            repository.loginWithOtp(AuthIdentityType.PHONE, CHALLENGE_ID, "123456")
        }

        assertSame(callerCancellation, thrown)
        assertNull(repository.session.value)
        assertTrue(!sessionStore.hasSessionMaterial())
    }

    private suspend fun captureCancellation(block: suspend () -> Unit): CancellationException = try {
        block()
        fail("Expected the original CancellationException")
        error("unreachable")
    } catch (error: CancellationException) {
        error
    }

    private fun authApi(
        response: AuthTokenResponse,
        logout: (String, Continuation<LogoutResponse>) -> Any?,
    ): AuthApi = Proxy.newProxyInstance(
        AuthApi::class.java.classLoader,
        arrayOf(AuthApi::class.java),
    ) { _, method, arguments ->
        when (method.name) {
            "login" -> response
            "refresh" -> response
            "logout" -> {
                val callArguments = requireNotNull(arguments)
                @Suppress("UNCHECKED_CAST")
                val continuation = callArguments.last() as Continuation<LogoutResponse>
                logout(callArguments.first() as String, continuation)
            }
            else -> error("Unexpected AuthApi call: ${method.name}")
        }
    } as AuthApi

    private fun tokens(): AuthTokenResponse {
        val now = Instant.now()
        return AuthTokenResponse(
            userId = "11111111-1111-4111-8111-111111111111",
            sessionId = "22222222-2222-4222-8222-222222222222",
            tokenType = "Bearer",
            accessToken = "a".repeat(43),
            accessTokenExpiresAt = now.plusSeconds(600).toString(),
            refreshToken = "r".repeat(43),
            refreshTokenExpiresAt = now.plusSeconds(86_400).toString(),
        )
    }

    private class CancellingSessionWriteDataStore(
        private val cancellation: CancellationException,
        armedInitially: Boolean = true,
        private val cleanupCancellation: CancellationException? = null,
    ) : DataStore<Preferences> {
        private val state = MutableStateFlow<Preferences>(emptyPreferences())
        private var armed = armedInitially
        private var sessionWriteCancelled = false
        private var cleanupCancelled = false
        override val data: Flow<Preferences> = state

        fun arm() {
            armed = true
        }

        override suspend fun updateData(
            transform: suspend (Preferences) -> Preferences,
        ): Preferences {
            val updated = transform(state.value)
            state.value = updated
            val containsSessionMaterial = AuthPreferenceKeys.sessionKeys.any(updated::contains)
            if (armed && containsSessionMaterial && !sessionWriteCancelled) {
                sessionWriteCancelled = true
                throw cancellation
            }
            if (
                sessionWriteCancelled &&
                !containsSessionMaterial &&
                !cleanupCancelled &&
                cleanupCancellation != null
            ) {
                cleanupCancelled = true
                throw cleanupCancellation
            }
            return updated
        }
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

    private companion object {
        const val CHALLENGE_ID = "44444444-4444-4444-8444-444444444444"
    }
}
