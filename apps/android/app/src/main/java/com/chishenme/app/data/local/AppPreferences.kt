package com.chishenme.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import com.chishenme.app.data.remote.RecommendationPreferenceVector
import java.io.IOException
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

enum class ThemePreference { SYSTEM, LIGHT, DARK }

object ConsentDocumentVersions {
    const val PRIVACY = "privacy-alpha-2026-10-11.2"
    const val TERMS = "terms-alpha-2026-08-20.1"
    const val SDK = "sdk-list-alpha-2026-10-11.2"
    const val AI = "ai-notice-alpha-2026-08-20.1"
    const val DISPLAY = "内部 Alpha 2026-10-11.2"
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

    val recommendationPreferenceVector: Flow<RecommendationPreferenceVector> =
        safeData.map { preferences -> readRecommendationPreferenceVector(preferences) }

    val recommendationPreferenceVectorStored: Flow<Boolean> = safeData.map { preferences ->
        RecommendationPreferenceKeys.any { key -> preferences[key] != null }
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
                RecommendationPreferenceKeys.forEach(preferences::remove)
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

    suspend fun setRecommendationPreferenceVector(vector: RecommendationPreferenceVector) {
        dataStore.edit { preferences ->
            preferences[RecommendationQualityPreference] = vector.quality
            preferences[RecommendationTimePreference] = vector.time
            preferences[RecommendationBudgetPreference] = vector.budget
            preferences[RecommendationMealMatchPreference] = vector.mealMatch
            preferences[RecommendationDiversityPreference] = vector.diversity
        }
    }

    suspend fun resetRecommendationPreferenceVector() {
        setRecommendationPreferenceVector(RecommendationPreferenceVector.Default)
    }

    suspend fun clearRecommendationPreferenceVector() {
        dataStore.edit { preferences ->
            RecommendationPreferenceKeys.forEach(preferences::remove)
        }
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
        val RecommendationQualityPreference = intPreferencesKey("recommendation_preference_quality_v1")
        val RecommendationTimePreference = intPreferencesKey("recommendation_preference_time_v1")
        val RecommendationBudgetPreference = intPreferencesKey("recommendation_preference_budget_v1")
        val RecommendationMealMatchPreference = intPreferencesKey("recommendation_preference_meal_match_v1")
        val RecommendationDiversityPreference = intPreferencesKey("recommendation_preference_diversity_v1")
        val RecommendationPreferenceKeys = listOf(
            RecommendationQualityPreference,
            RecommendationTimePreference,
            RecommendationBudgetPreference,
            RecommendationMealMatchPreference,
            RecommendationDiversityPreference,
        )

        fun readRecommendationPreferenceVector(preferences: Preferences): RecommendationPreferenceVector {
            val defaults = RecommendationPreferenceVector.Default
            return RecommendationPreferenceVector(
                quality = preferences[RecommendationQualityPreference]
                    ?.takeIf { it in 0..100 } ?: defaults.quality,
                time = preferences[RecommendationTimePreference]
                    ?.takeIf { it in 0..100 } ?: defaults.time,
                budget = preferences[RecommendationBudgetPreference]
                    ?.takeIf { it in 0..100 } ?: defaults.budget,
                mealMatch = preferences[RecommendationMealMatchPreference]
                    ?.takeIf { it in 0..100 } ?: defaults.mealMatch,
                diversity = preferences[RecommendationDiversityPreference]
                    ?.takeIf { it in 0..100 } ?: defaults.diversity,
            )
        }
    }
}
