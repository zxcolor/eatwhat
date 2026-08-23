package com.chishenme.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthSessionStoreTest {
    @Test
    fun `encrypted refresh token round trips without plaintext preferences`() = runTest {
        val cipher = FakeCipher()
        val preferences = InMemoryAuthPreferencesDataStore()
        val store = AuthSessionStore(preferences, cipher)
        assertFalse(store.hasSessionMaterial())
        val installationId = store.installationId()
        val input = AuthSessionToPersist(
            userId = "11111111-1111-4111-8111-111111111111",
            sessionId = "22222222-2222-4222-8222-222222222222",
            refreshToken = "r".repeat(43),
            refreshTokenExpiresAt = Instant.parse("2026-09-20T00:00:00Z"),
        )

        store.save(input)
        assertTrue(store.hasSessionMaterial())
        val loaded = store.load()

        assertEquals(input.userId, loaded?.userId)
        assertEquals(input.sessionId, loaded?.sessionId)
        assertEquals(input.refreshToken, loaded?.refreshToken)
        assertEquals(installationId, loaded?.installationId)
        assertEquals(1, cipher.encryptions)
        assertEquals(1, cipher.decryptions)
        assertFalse(preferences.snapshot().asMap().values.contains(input.refreshToken))
    }

    @Test
    fun `cipher failure clears unusable session`() = runTest {
        val cipher = FakeCipher()
        val store = store(cipher)
        store.installationId()
        store.save(
            AuthSessionToPersist(
                userId = "11111111-1111-4111-8111-111111111111",
                sessionId = "22222222-2222-4222-8222-222222222222",
                refreshToken = "r".repeat(43),
                refreshTokenExpiresAt = Instant.parse("2026-09-20T00:00:00Z"),
            ),
        )
        cipher.failDecrypt = true

        assertNull(store.load())
        cipher.failDecrypt = false
        assertNull(store.load())
    }

    @Test
    fun `logout clears session and keystore key but retains installation`() = runTest {
        val cipher = FakeCipher()
        val store = store(cipher)
        val installation = store.installationId()
        store.save(
            AuthSessionToPersist(
                userId = "11111111-1111-4111-8111-111111111111",
                sessionId = "22222222-2222-4222-8222-222222222222",
                refreshToken = "r".repeat(43),
                refreshTokenExpiresAt = Instant.parse("2026-09-20T00:00:00Z"),
            ),
        )

        store.clear()

        assertFalse(store.hasSessionMaterial())
        assertNull(store.load())
        assertEquals(installation, store.installationId())
        assertEquals(1, cipher.deletions)
    }

    @Test(expected = CancellationException::class)
    fun `cancellation during decrypt propagates without deleting session`() = runTest {
        val cipher = FakeCipher()
        val store = store(cipher)
        store.installationId()
        store.save(
            AuthSessionToPersist(
                userId = "11111111-1111-4111-8111-111111111111",
                sessionId = "22222222-2222-4222-8222-222222222222",
                refreshToken = "r".repeat(43),
                refreshTokenExpiresAt = Instant.parse("2026-09-20T00:00:00Z"),
            ),
        )
        cipher.cancelDecrypt = true

        try {
            store.load()
        } finally {
            assertEquals(0, cipher.deletions)
        }
    }

    private fun store(cipher: RefreshTokenCipher): AuthSessionStore =
        AuthSessionStore(InMemoryAuthPreferencesDataStore(), cipher)

    private class FakeCipher : RefreshTokenCipher {
        var encryptions = 0
        var decryptions = 0
        var deletions = 0
        var failDecrypt = false
        var cancelDecrypt = false
        private val values = mutableMapOf<String, String>()

        override fun encrypt(plaintext: String, associatedData: ByteArray): String {
            encryptions += 1
            val envelope = "fake-$encryptions"
            values[envelope + associatedData.decodeToString()] = plaintext
            return envelope
        }

        override fun decrypt(envelope: String, associatedData: ByteArray): String {
            decryptions += 1
            if (cancelDecrypt) throw CancellationException("test cancellation")
            if (failDecrypt) throw AuthCipherException()
            return values[envelope + associatedData.decodeToString()] ?: throw AuthCipherException()
        }

        override fun deleteKey() {
            deletions += 1
            values.clear()
        }
    }
}

private class InMemoryAuthPreferencesDataStore : DataStore<Preferences> {
    private val state = MutableStateFlow<Preferences>(emptyPreferences())
    override val data: Flow<Preferences> = state

    override suspend fun updateData(
        transform: suspend (Preferences) -> Preferences,
    ): Preferences {
        val updated = transform(state.value)
        state.value = updated
        return updated
    }

    fun snapshot(): Preferences = state.value
}
