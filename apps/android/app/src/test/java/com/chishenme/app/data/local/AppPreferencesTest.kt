package com.chishenme.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import com.chishenme.app.data.remote.RecommendationPreferenceVector
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppPreferencesTest {
    @Test
    fun `material SMS and mail disclosure update requires fresh consent`() = runTest {
        val store = InMemoryPreferencesDataStore(
            mutablePreferencesOf(
                booleanPreferencesKey("privacy_accepted_v1") to true,
                stringPreferencesKey("privacy_policy_version") to ConsentDocumentVersions.PRIVACY,
                stringPreferencesKey("terms_version") to ConsentDocumentVersions.TERMS,
                stringPreferencesKey("sdk_list_version") to "sdk-list-alpha-2026-08-21.2",
                stringPreferencesKey("ai_notice_version") to ConsentDocumentVersions.AI,
            ),
        )
        val preferences = AppPreferences(store)

        assertFalse(preferences.privacyAccepted.first())
        preferences.setPrivacyAccepted(true)
        assertTrue(preferences.privacyAccepted.first())
    }

    @Test
    fun `AI assistance is off until the user explicitly enables it`() = runTest {
        val preferences = AppPreferences(InMemoryPreferencesDataStore())

        assertFalse(preferences.aiAssistanceEnabled.first())

        preferences.setAiAssistanceEnabled(true)

        assertTrue(preferences.aiAssistanceEnabled.first())
    }

    @Test
    fun `recommendation preferences default locally and can be stored and cleared`() = runTest {
        val preferences = AppPreferences(InMemoryPreferencesDataStore())
        val customized = RecommendationPreferenceVector(
            quality = 85,
            time = 100,
            budget = 45,
            mealMatch = 70,
            diversity = 20,
        )

        assertEquals(RecommendationPreferenceVector.Default, preferences.recommendationPreferenceVector.first())
        assertFalse(preferences.recommendationPreferenceVectorStored.first())

        preferences.setRecommendationPreferenceVector(customized)

        assertEquals(customized, preferences.recommendationPreferenceVector.first())
        assertTrue(preferences.recommendationPreferenceVectorStored.first())

        preferences.resetRecommendationPreferenceVector()

        assertEquals(RecommendationPreferenceVector.Default, preferences.recommendationPreferenceVector.first())
        assertTrue(preferences.recommendationPreferenceVectorStored.first())

        preferences.setRecommendationPreferenceVector(customized)

        preferences.clearRecommendationPreferenceVector()

        assertEquals(RecommendationPreferenceVector.Default, preferences.recommendationPreferenceVector.first())
        assertFalse(preferences.recommendationPreferenceVectorStored.first())
    }

    @Test
    fun `corrupt stored recommendation weights fail back to safe defaults per dimension`() = runTest {
        val store = InMemoryPreferencesDataStore(
            mutablePreferencesOf(
                intPreferencesKey("recommendation_preference_quality_v1") to 101,
                intPreferencesKey("recommendation_preference_time_v1") to -1,
                intPreferencesKey("recommendation_preference_budget_v1") to 40,
            ),
        )

        assertEquals(
            RecommendationPreferenceVector(budget = 40),
            AppPreferences(store).recommendationPreferenceVector.first(),
        )
    }

    @Test
    fun `privacy withdrawal atomically rejects consent and removes DataStore session material`() = runTest {
        val store = InMemoryPreferencesDataStore(
            mutablePreferencesOf(
                booleanPreferencesKey("privacy_accepted_v1") to true,
                stringPreferencesKey("privacy_policy_version") to ConsentDocumentVersions.PRIVACY,
                stringPreferencesKey("terms_version") to ConsentDocumentVersions.TERMS,
                stringPreferencesKey("sdk_list_version") to ConsentDocumentVersions.SDK,
                stringPreferencesKey("ai_notice_version") to ConsentDocumentVersions.AI,
                DecisionHistoryJson to "[]",
                intPreferencesKey("recommendation_preference_quality_v1") to 80,
                intPreferencesKey("recommendation_preference_time_v1") to 90,
                intPreferencesKey("recommendation_preference_budget_v1") to 70,
                intPreferencesKey("recommendation_preference_meal_match_v1") to 60,
                intPreferencesKey("recommendation_preference_diversity_v1") to 50,
                AuthPreferenceKeys.InstallationId to "10000000-0000-4000-8000-000000000001",
                AuthPreferenceKeys.RefreshEnvelope to "encrypted-refresh-token",
                AuthPreferenceKeys.UserId to "20000000-0000-4000-8000-000000000001",
                AuthPreferenceKeys.SessionId to "30000000-0000-4000-8000-000000000001",
                AuthPreferenceKeys.RefreshExpiresAt to "2026-09-22T00:00:00Z",
            ),
        )
        val preferences = AppPreferences(store)
        val writesBeforeWithdrawal = store.updateCount

        preferences.setPrivacyAccepted(false)

        assertEquals(writesBeforeWithdrawal + 1, store.updateCount)
        assertFalse(preferences.privacyAccepted.first())
        val snapshot = store.data.first()
        assertNull(snapshot[DecisionHistoryJson])
        assertNull(snapshot[intPreferencesKey("recommendation_preference_quality_v1")])
        assertNull(snapshot[intPreferencesKey("recommendation_preference_time_v1")])
        assertNull(snapshot[intPreferencesKey("recommendation_preference_budget_v1")])
        assertNull(snapshot[intPreferencesKey("recommendation_preference_meal_match_v1")])
        assertNull(snapshot[intPreferencesKey("recommendation_preference_diversity_v1")])
        assertNull(snapshot[AuthPreferenceKeys.InstallationId])
        AuthPreferenceKeys.sessionKeys.forEach { key -> assertNull(snapshot[key]) }
        assertFalse(
            "a rebuilt coordinator must observe durable rejection",
            AppPreferences(store).privacyAccepted.first(),
        )
    }
}

private class InMemoryPreferencesDataStore(
    initial: Preferences = emptyPreferences(),
) : DataStore<Preferences> {
    private val state = MutableStateFlow(initial)
    var updateCount: Int = 0
        private set

    override val data: Flow<Preferences> = state

    override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
        updateCount += 1
        val updated = transform(state.value)
        state.value = updated
        return updated
    }
}
