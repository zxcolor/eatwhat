package com.chishenme.app.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.local.AppPreferences
import com.chishenme.app.data.local.DecisionHistoryEntry
import com.chishenme.app.data.local.DecisionHistoryStore
import com.chishenme.app.data.local.ThemePreference
import com.chishenme.app.data.remote.RecommendationPreferenceVector
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val preferences: AppPreferences,
    private val historyStore: DecisionHistoryStore,
) : ViewModel() {
    val aiEnabled: StateFlow<Boolean> = preferences.aiAssistanceEnabled
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    val theme: StateFlow<ThemePreference> = preferences.themePreference
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ThemePreference.SYSTEM)

    val recommendationPreferenceVector: StateFlow<RecommendationPreferenceVector> =
        preferences.recommendationPreferenceVector.stateIn(
            viewModelScope,
            SharingStarted.WhileSubscribed(5_000),
            RecommendationPreferenceVector.Default,
        )

    val recommendationPreferenceVectorStored: StateFlow<Boolean> =
        preferences.recommendationPreferenceVectorStored.stateIn(
            viewModelScope,
            SharingStarted.WhileSubscribed(5_000),
            false,
        )

    val decisionHistory: StateFlow<List<DecisionHistoryEntry>> = historyStore.entries
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun setAiEnabled(enabled: Boolean) {
        viewModelScope.launch { preferences.setAiAssistanceEnabled(enabled) }
    }

    fun setTheme(theme: ThemePreference) {
        viewModelScope.launch { preferences.setThemePreference(theme) }
    }

    fun setRecommendationPreferenceVector(vector: RecommendationPreferenceVector) {
        viewModelScope.launch { preferences.setRecommendationPreferenceVector(vector) }
    }

    fun resetRecommendationPreferenceVector() {
        viewModelScope.launch { preferences.resetRecommendationPreferenceVector() }
    }

    fun clearRecommendationPreferenceVector() {
        viewModelScope.launch { preferences.clearRecommendationPreferenceVector() }
    }

    fun clearDecisionHistory() {
        viewModelScope.launch { historyStore.clear() }
    }
}
