package com.chishenme.app.feature.decision

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import com.chishenme.app.data.LocationSearchRepository
import com.chishenme.app.data.RecommendationRepository
import com.chishenme.app.data.local.AppPreferences
import com.chishenme.app.data.local.DecisionHistoryStore
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.LocationSearchApi
import com.chishenme.app.data.remote.LocationSearchCoordinate
import com.chishenme.app.data.remote.LocationSearchDataMode
import com.chishenme.app.data.remote.LocationSearchPlace
import com.chishenme.app.data.remote.LocationSearchRequest
import com.chishenme.app.data.remote.LocationSearchResponse
import com.chishenme.app.data.remote.RecommendationApi
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationEvent
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.ServiceCapabilities
import com.chishenme.app.location.ForegroundLocationClient
import com.chishenme.app.location.ForegroundLocationResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class DecisionLocationSearchLifecycleTest {
    @Test
    fun `closing chooser prevents a non cooperative late response from changing state`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LateLocationSearchApi()
            val dataStore = SearchFakePreferencesDataStore()
            val viewModel = DecisionViewModel(
                repository = RecommendationRepository(SearchUnusedRecommendationApi),
                locationSearchRepository = LocationSearchRepository(api),
                preferences = AppPreferences(dataStore),
                historyStore = DecisionHistoryStore(dataStore, Json { ignoreUnknownKeys = true }),
                locationClient = SearchUnusedLocationClient,
                runtimeAppVersionGate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.startConsentSession()
            runCurrent()

            viewModel.openLocationChooser()
            viewModel.updateLocationSearchQuery("旧地点")
            viewModel.searchLocation()
            runCurrent()
            assertTrue(api.started.isCompleted)
            assertEquals(LocationSearchUiState.Loading, viewModel.uiState.value.locationSearchState)

            viewModel.dismissLocationSearch()
            assertEquals("", viewModel.uiState.value.locationSearchQuery)
            assertEquals(false, viewModel.uiState.value.locationChooserOpen)
            assertEquals(LocationSearchUiState.Idle, viewModel.uiState.value.locationSearchState)

            api.release.complete(Unit)
            advanceUntilIdle()

            assertEquals(LocationSearchUiState.Idle, viewModel.uiState.value.locationSearchState)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `retained view model keeps chooser draft and ready result until explicit dismissal`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LateLocationSearchApi()
            val dataStore = SearchFakePreferencesDataStore()
            val viewModel = DecisionViewModel(
                repository = RecommendationRepository(SearchUnusedRecommendationApi),
                locationSearchRepository = LocationSearchRepository(api),
                preferences = AppPreferences(dataStore),
                historyStore = DecisionHistoryStore(dataStore, Json { ignoreUnknownKeys = true }),
                locationClient = SearchUnusedLocationClient,
                runtimeAppVersionGate =
                    com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.startConsentSession()
            runCurrent()
            viewModel.openLocationChooser()
            viewModel.updateLocationSearchQuery("北京大学")
            viewModel.searchLocation()
            runCurrent()
            assertEquals(LocationSearchUiState.Loading, viewModel.uiState.value.locationSearchState)

            // Re-wiring the same retained ViewModel during Activity recreation is a no-op.
            viewModel.ensureConsentSessionStarted()
            runCurrent()
            assertEquals(LocationSearchUiState.Loading, viewModel.uiState.value.locationSearchState)
            assertTrue(viewModel.uiState.value.locationChooserOpen)
            assertEquals("北京大学", viewModel.uiState.value.locationSearchQuery)

            api.release.complete(Unit)
            advanceUntilIdle()

            val ready = viewModel.uiState.value.locationSearchState
            assertTrue(ready is LocationSearchUiState.Ready)
            assertTrue(viewModel.uiState.value.locationChooserOpen)
            assertEquals("北京大学", viewModel.uiState.value.locationSearchQuery)

            // A new Home composition after Activity recreation calls ensure again.
            // The retained ViewModel must treat that wiring as idempotent.
            viewModel.ensureConsentSessionStarted()
            advanceUntilIdle()
            assertEquals(ready, viewModel.uiState.value.locationSearchState)
            assertTrue(viewModel.uiState.value.locationChooserOpen)
            assertEquals("北京大学", viewModel.uiState.value.locationSearchQuery)

            viewModel.dismissLocationSearch()
            assertEquals(LocationSearchUiState.Idle, viewModel.uiState.value.locationSearchState)
            assertEquals("", viewModel.uiState.value.locationSearchQuery)
            assertEquals(false, viewModel.uiState.value.locationChooserOpen)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `privacy withdrawal clears chooser and rejects a non cooperative late response`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LateLocationSearchApi()
            val dataStore = SearchFakePreferencesDataStore()
            val viewModel = DecisionViewModel(
                repository = RecommendationRepository(SearchUnusedRecommendationApi),
                locationSearchRepository = LocationSearchRepository(api),
                preferences = AppPreferences(dataStore),
                historyStore = DecisionHistoryStore(dataStore, Json { ignoreUnknownKeys = true }),
                locationClient = SearchUnusedLocationClient,
                runtimeAppVersionGate =
                    com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.startConsentSession()
            runCurrent()
            viewModel.openLocationChooser()
            viewModel.updateLocationSearchQuery("隐私测试地点")
            viewModel.searchLocation()
            runCurrent()
            assertTrue(api.started.isCompleted)

            viewModel.clearForPrivacyWithdrawal()
            assertEquals(DecisionUiState(), viewModel.uiState.value)

            api.release.complete(Unit)
            advanceUntilIdle()
            assertEquals(DecisionUiState(), viewModel.uiState.value)
        } finally {
            Dispatchers.resetMain()
        }
    }
}

private class LateLocationSearchApi : LocationSearchApi {
    val started = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()

    override suspend fun search(request: LocationSearchRequest): LocationSearchResponse =
        withContext(NonCancellable) {
            started.complete(Unit)
            release.await()
            LocationSearchResponse(
                requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
                dataSource = "FUTURE_PROVIDER",
                dataMode = LocationSearchDataMode.LIVE,
                results = listOf(
                    LocationSearchPlace(
                        name = "不应出现的晚到地点",
                        address = null,
                        location = LocationSearchCoordinate(
                            latitude = 39.98,
                            longitude = 116.31,
                            crs = CoordinateReferenceSystem.GCJ02,
                        ),
                        sourceLabel = "地点合作方",
                        providerRank = 1,
                    ),
                ),
            )
        }
}

private class SearchFakePreferencesDataStore : DataStore<Preferences> {
    private val state = MutableStateFlow<Preferences>(emptyPreferences())
    override val data: Flow<Preferences> = state

    override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
        val updated = transform(state.value)
        state.value = updated
        return updated
    }
}

private object SearchUnusedLocationClient : ForegroundLocationClient {
    override suspend fun currentLocation(): ForegroundLocationResult = error("unused")
}

private object SearchUnusedRecommendationApi : RecommendationApi {
    override suspend fun featureConfig(): FeatureConfig = FeatureConfig(
        coverageName = "北京四环内",
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        aiEnabled = false,
        accountsEnabled = false,
        favoritesEnabled = false,
        minimumSupportedVersion = "0.1.0",
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback",
        serviceCapabilities = ServiceCapabilities(
            locationSearchEnabled = true,
        ),
    )
    override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")
    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
}
