package com.chishenme.app.feature.decision

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import com.chishenme.app.data.RecommendationRepository
import com.chishenme.app.data.LocationSearchRepository
import com.chishenme.app.data.local.AppPreferences
import com.chishenme.app.data.local.DecisionHistoryStore
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.IncompatibleApiContractException
import com.chishenme.app.data.remote.LocationSearchApi
import com.chishenme.app.data.remote.LocationSearchRequest
import com.chishenme.app.data.remote.LocationSearchResponse
import com.chishenme.app.data.remote.RecommendationApi
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationEvent
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.location.ForegroundLocationClient
import com.chishenme.app.location.ForegroundLocationResult
import com.chishenme.app.location.LocationAccess
import com.chishenme.app.location.LocationUiState
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class DecisionLocationLifecycleTest {
    @Test
    fun `startup distinguishes incompatible config and leaves AI unavailable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = decisionViewModelWithConfigFailure(
                IOException("network wrapper", IncompatibleApiContractException()),
            )

            viewModel.startConsentSession()
            runCurrent()

            assertEquals(null, viewModel.uiState.value.featureConfig)
            assertEquals(
                "当前 App 与服务版本不兼容，请更新 App；AI 已按安全默认值关闭",
                viewModel.uiState.value.transientMessage,
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `startup reports unavailable config separately and leaves AI unavailable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = decisionViewModelWithConfigFailure(IOException("offline"))

            viewModel.startConsentSession()
            runCurrent()

            assertEquals(null, viewModel.uiState.value.featureConfig)
            assertEquals(
                "远程配置暂不可用，AI 已按安全默认值关闭",
                viewModel.uiState.value.transientMessage,
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `cancellation reducer clears only active location progress`() {
        val original = DecisionUiState(
            loadState = RecommendationLoadState.Failed("保留现有推荐状态"),
            transientMessage = "保留现有消息",
            locationState = LocationUiState.Locating,
        )

        val cancelled = original.afterLocationRequestCancellation()

        assertEquals(LocationUiState.Idle, cancelled.locationState)
        assertEquals(original.input, cancelled.input)
        assertSame(original.loadState, cancelled.loadState)
        assertEquals(original.transientMessage, cancelled.transientMessage)
    }

    @Test
    fun `cancellation reducer preserves completed location state`() {
        val ready = DecisionUiState(
            locationState = LocationUiState.Ready(
                access = LocationAccess.APPROXIMATE,
                accuracyMeters = 1_500.0,
            ),
        )

        assertSame(ready, ready.afterLocationRequestCancellation())
    }

    @Test
    fun `view model cancellation stops only the active location job`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val locationClient = BlockingLocationClient()
            val dataStore = FakePreferencesDataStore()
            val viewModel = DecisionViewModel(
                repository = RecommendationRepository(UnusedRecommendationApi),
                locationSearchRepository = LocationSearchRepository(UnusedLocationSearchApi),
                preferences = AppPreferences(dataStore),
                historyStore = DecisionHistoryStore(dataStore, Json { ignoreUnknownKeys = true }),
                locationClient = locationClient,
                runtimeAppVersionGate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.locate()
            runCurrent()
            assertTrue(locationClient.started.isCompleted)
            assertEquals(LocationUiState.Locating, viewModel.uiState.value.locationState)

            viewModel.cancelLocationRequest()
            runCurrent()

            assertTrue(locationClient.cancelled.isCompleted)
            assertEquals(LocationUiState.Idle, viewModel.uiState.value.locationState)
            assertEquals(RecommendationLoadState.Idle, viewModel.uiState.value.loadState)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun decisionViewModelWithConfigFailure(error: IOException): DecisionViewModel {
        val dataStore = FakePreferencesDataStore()
        return DecisionViewModel(
            repository = RecommendationRepository(
                object : RecommendationApi {
                    override suspend fun featureConfig(): FeatureConfig = throw error

                    override suspend fun recommend(
                        context: RecommendationContext,
                    ): RecommendationResponse = kotlin.error("unused")

                    override suspend fun recordEvent(
                        event: RecommendationEvent,
                    ): Response<Unit> = kotlin.error("unused")
                },
            ),
            locationSearchRepository = LocationSearchRepository(UnusedLocationSearchApi),
            preferences = AppPreferences(dataStore),
            historyStore = DecisionHistoryStore(dataStore, Json { ignoreUnknownKeys = true }),
            locationClient = object : ForegroundLocationClient {
                override suspend fun currentLocation(): ForegroundLocationResult = kotlin.error("unused")
            },
            runtimeAppVersionGate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
        )
    }
}

private class BlockingLocationClient : ForegroundLocationClient {
    val started = CompletableDeferred<Unit>()
    val cancelled = CompletableDeferred<Unit>()

    override suspend fun currentLocation(): ForegroundLocationResult {
        started.complete(Unit)
        try {
            awaitCancellation()
        } finally {
            cancelled.complete(Unit)
        }
    }
}

private class FakePreferencesDataStore : DataStore<Preferences> {
    private val state = MutableStateFlow<Preferences>(emptyPreferences())
    override val data: Flow<Preferences> = state

    override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
        val updated = transform(state.value)
        state.value = updated
        return updated
    }
}

private object UnusedRecommendationApi : RecommendationApi {
    override suspend fun featureConfig(): FeatureConfig = error("unused")

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
}

private object UnusedLocationSearchApi : LocationSearchApi {
    override suspend fun search(request: LocationSearchRequest): LocationSearchResponse = error("unused")
}
