package com.chishenme.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

enum class ThemePreference { SYSTEM, LIGHT, DARK }

object ConsentDocumentVersions {
    const val PRIVACY = "privacy-alpha-2026-08-20.1"
    const val TERMS = "terms-alpha-2026-08-20.1"
    const val SDK = "sdk-list-alpha-2026-08-26.4"
    const val AI = "ai-notice-alpha-2026-08-20.1"
    const val DISPLAY = "内部 Alpha 2026-08-26.4"
}

@Singleton
class AppPreferences @Inject constructor(
    private val dataStore: DataStore<Preferences>,
) {
    val privacyAccepted: Flow<Boolean> = safeData.map { preferences ->
        preferences[PrivacyAccepted] == true &&
            preferences[PrivacyVersion] == ConsentDocumentVersions.PRIVACY &&
            preferences[TermsVersion] == ConsentDocumentVersions.TERMS &&
            preferences[SdkListVersion] == ConsentDocumentVersions.SDK &&
            preferences[AiNoticeVersion] == ConsentDocumentVersions.AI
    }

    val aiAssistanceEnabled: Flow<Boolean> = safeData.map { preferences ->
        preferences[AiAssistanceEnabled] ?: false
    }

    val themePreference: Flow<ThemePreference> = safeData.map { preferences ->
        preferences[ThemeMode]
            ?.let { stored -> ThemePreference.entries.firstOrNull { it.name == stored } }
            ?: ThemePreference.SYSTEM
    }

    suspend fun setPrivacyAccepted(accepted: Boolean) {
        dataStore.edit { preferences ->
            preferences[PrivacyAccepted] = accepted
            if (accepted) {
                preferences[PrivacyVersion] = ConsentDocumentVersions.PRIVACY
                preferences[TermsVersion] = ConsentDocumentVersions.TERMS
                preferences[SdkListVersion] = ConsentDocumentVersions.SDK
                preferences[AiNoticeVersion] = ConsentDocumentVersions.AI
                preferences[ConsentAcceptedAt] = Instant.now().toString()
            } else {
                preferences[ConsentWithdrawnAt] = Instant.now().toString()
                preferences.remove(DecisionHistoryJson)
                AuthPreferenceKeys.sessionKeys.forEach(preferences::remove)
                preferences.remove(AuthPreferenceKeys.InstallationId)
            }
        }
    }

    suspend fun setAiAssistanceEnabled(enabled: Boolean) {
        dataStore.edit { it[AiAssistanceEnabled] = enabled }
    }

    suspend fun setThemePreference(theme: ThemePreference) {
        dataStore.edit { it[ThemeMode] = theme.name }
    }

    private val safeData: Flow<Preferences>
        get() = dataStore.data.catch { error ->
            if (error is IOException) emit(androidx.datastore.preferences.core.emptyPreferences()) else throw error
        }

    private companion object {
        val PrivacyAccepted = booleanPreferencesKey("privacy_accepted_v1")
        val PrivacyVersion = stringPreferencesKey("privacy_policy_version")
        val TermsVersion = stringPreferencesKey("terms_version")
        val SdkListVersion = stringPreferencesKey("sdk_list_version")
        val AiNoticeVersion = stringPreferencesKey("ai_notice_version")
        val ConsentAcceptedAt = stringPreferencesKey("consent_accepted_at")
        val ConsentWithdrawnAt = stringPreferencesKey("consent_withdrawn_at")
        val AiAssistanceEnabled = booleanPreferencesKey("ai_assistance_enabled")
        val ThemeMode = stringPreferencesKey("theme_mode")
    }
}
