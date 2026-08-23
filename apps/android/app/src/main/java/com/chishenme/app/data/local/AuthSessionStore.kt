package com.chishenme.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal object AuthPreferenceKeys {
    val InstallationId = stringPreferencesKey("auth_installation_id_v1")
    val RefreshEnvelope = stringPreferencesKey("auth_refresh_envelope_v1")
    val UserId = stringPreferencesKey("auth_user_id_v1")
    val SessionId = stringPreferencesKey("auth_session_id_v1")
    val RefreshExpiresAt = stringPreferencesKey("auth_refresh_expires_at_v1")

    val sessionKeys: List<Preferences.Key<String>> = listOf(
        RefreshEnvelope,
        UserId,
        SessionId,
        RefreshExpiresAt,
    )
}

data class StoredAuthSession(
    val userId: String,
    val sessionId: String,
    val refreshToken: String,
    val refreshTokenExpiresAt: Instant,
    val installationId: String,
)

data class AuthSessionToPersist(
    val userId: String,
    val sessionId: String,
    val refreshToken: String,
    val refreshTokenExpiresAt: Instant,
)

@Singleton
class AuthSessionStore @Inject internal constructor(
    private val dataStore: DataStore<Preferences>,
    private val cipher: RefreshTokenCipher,
) {
    private val mutex = Mutex()

    suspend fun installationId(): String = mutex.withLock {
        val current = safePreferences()[AuthPreferenceKeys.InstallationId]
        if (current.isUuid()) return@withLock current.orEmpty()

        val generated = UUID.randomUUID().toString()
        dataStore.edit { it[AuthPreferenceKeys.InstallationId] = generated }
        generated
    }

    /**
     * Reports whether this installation currently carries any session material.
     *
     * Unlike [load], this read deliberately does not turn an I/O failure into an
     * empty preference set. Optional-authentication callers use the distinction
     * to avoid silently treating an unreadable or corrupt signed-in session as a
     * guest submission.
     */
    suspend fun hasSessionMaterial(): Boolean = mutex.withLock {
        val preferences = dataStore.data.first()
        AuthPreferenceKeys.sessionKeys.any { key -> preferences.contains(key) }
    }

    suspend fun load(): StoredAuthSession? = mutex.withLock {
        val preferences = safePreferences()
        val installationId = preferences[AuthPreferenceKeys.InstallationId]
        val userId = preferences[AuthPreferenceKeys.UserId]
        val sessionId = preferences[AuthPreferenceKeys.SessionId]
        val expiresAtRaw = preferences[AuthPreferenceKeys.RefreshExpiresAt]
        val expiresAt = expiresAtRaw
            ?.let { raw -> runCatching { Instant.parse(raw) }.getOrNull() }
        val envelope = preferences[AuthPreferenceKeys.RefreshEnvelope]
        val hasStoredSession = listOf(userId, sessionId, expiresAtRaw, envelope)
            .any { !it.isNullOrBlank() }
        if (!hasStoredSession) return@withLock null
        if (
            !installationId.isUuid() ||
            !userId.isUuid() ||
            !sessionId.isUuid() ||
            expiresAt == null ||
            envelope.isNullOrBlank()
        ) {
            withContext(Dispatchers.IO) { cipher.deleteKey() }
            clearSessionPreferences()
            return@withLock null
        }

        val refreshToken = try {
            withContext(Dispatchers.IO) {
                cipher.decrypt(
                    envelope,
                    associatedData(userId.orEmpty(), sessionId.orEmpty(), installationId.orEmpty()),
                )
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        }
        if (refreshToken == null) {
            withContext(Dispatchers.IO) { cipher.deleteKey() }
            clearSessionPreferences()
            return@withLock null
        }

        StoredAuthSession(
            userId = userId.orEmpty(),
            sessionId = sessionId.orEmpty(),
            refreshToken = refreshToken,
            refreshTokenExpiresAt = expiresAt,
            installationId = installationId.orEmpty(),
        )
    }

    suspend fun save(session: AuthSessionToPersist) = mutex.withLock {
        require(session.userId.isUuid())
        require(session.sessionId.isUuid())
        require(session.refreshToken.matches(OPAQUE_TOKEN))
        val installationId = safePreferences()[AuthPreferenceKeys.InstallationId]
            .takeIf { it.isUuid() }
            ?: UUID.randomUUID().toString()
        val envelope = withContext(Dispatchers.IO) {
            cipher.encrypt(
                session.refreshToken,
                associatedData(session.userId, session.sessionId, installationId),
            )
        }
        dataStore.edit { preferences ->
            preferences[AuthPreferenceKeys.InstallationId] = installationId
            preferences[AuthPreferenceKeys.RefreshEnvelope] = envelope
            preferences[AuthPreferenceKeys.UserId] = session.userId
            preferences[AuthPreferenceKeys.SessionId] = session.sessionId
            preferences[AuthPreferenceKeys.RefreshExpiresAt] = session.refreshTokenExpiresAt.toString()
        }
    }

    suspend fun clear() = mutex.withLock {
        withContext(Dispatchers.IO) { cipher.deleteKey() }
        clearSessionPreferences()
    }

    private suspend fun safePreferences(): Preferences = dataStore.data
        .catch { error ->
            if (error is IOException) {
                emit(androidx.datastore.preferences.core.emptyPreferences())
            } else {
                throw error
            }
        }
        .first()

    private suspend fun clearSessionPreferences() {
        dataStore.edit { preferences ->
            AuthPreferenceKeys.sessionKeys.forEach(preferences::remove)
        }
    }

    private fun associatedData(userId: String, sessionId: String, installationId: String): ByteArray =
        "chi-shen-me:auth-session:v1\u0000$userId\u0000$sessionId\u0000$installationId"
            .toByteArray(Charsets.UTF_8)

    private fun String?.isUuid(): Boolean {
        val value = this ?: return false
        return runCatching {
            UUID.fromString(value).toString() == value.lowercase()
        }.getOrDefault(false)
    }

    private companion object {
        val OPAQUE_TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    }
}
