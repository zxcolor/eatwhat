package com.chishenme.app.feature.decision

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import com.chishenme.app.data.LocationSearchRepository
import com.chishenme.app.data.RecommendationRepository
import com.chishenme.app.data.local.AppPreferences
import com.chishenme.app.data.local.DecisionHistoryStore
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.LocationSearchApi
import com.chishenme.app.data.remote.LocationSearchRequest
import com.chishenme.app.data.remote.LocationSearchResponse
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationApi
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationEvent
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.ReasonCode
import com.chishenme.app.data.remote.ServiceCapabilities
import com.chishenme.app.domain.BeijingPilotLocations
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import com.chishenme.app.feature.session.ResultSessionState
import com.chishenme.app.location.ForegroundLocationClient
import com.chishenme.app.location.ForegroundLocationResult
import java.io.IOException
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class DecisionFeatureConfigRefreshLifecycleTest {
    @Test
    fun `closed recommendation capability blocks transport after trusted config`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = ClosedRecommendationApi()
            val viewModel = viewModel(api)
            viewModel.startConsentSession()
            advanceUntilIdle()
            viewModel.setLocation(BeijingPilotLocations.choices.first())

            assertFalse(viewModel.recommend())
            advanceUntilIdle()

            assertEquals(0, api.recommendCalls)
            assertEquals(RecommendationLoadState.Idle, viewModel.uiState.value.loadState)
            assertEquals(
                "餐厅推荐服务当前未开放，请重新连接后再试",
                viewModel.uiState.value.formError,
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `idempotent consent initialization preserves ready result and detail selection`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = ImmediateRecommendationApi()
            val viewModel = viewModel(api)
            viewModel.ensureConsentSessionStarted()
            advanceUntilIdle()
            viewModel.setLocation(BeijingPilotLocations.choices.first())
            assertTrue(viewModel.recommend())
            advanceUntilIdle()
            val resultToken = currentRecommendationResponse().results.single().resultToken
            assertTrue(
                (viewModel.uiState.value.loadState as RecommendationLoadState.Ready)
                    .trustedCompatibleConfiguration,
            )
            assertEquals(1, api.eventCalls)
            assertTrue(viewModel.selectResultForDetail(resultToken))
            viewModel.recordEvent(
                currentRecommendationResponse().results.single(),
                com.chishenme.app.data.remote.RecommendationEventType.DETAIL,
            )
            advanceUntilIdle()
            assertEquals(2, api.eventCalls)
            val configurationGeneration =
                viewModel.runtimeAppVersionGate.currentState.trustedConfigurationGeneration

            viewModel.ensureConsentSessionStarted()
            advanceUntilIdle()

            assertEquals(1, api.featureConfigCalls)
            assertEquals(
                configurationGeneration,
                viewModel.runtimeAppVersionGate.currentState.trustedConfigurationGeneration,
            )
            assertEquals(ResultSessionState.CURRENT, viewModel.recommendationSessionState(resultToken))
            assertEquals(resultToken, viewModel.selectedResultForDetail()?.resultToken)

            viewModel.startConsentSession()
            assertEquals(RecommendationLoadState.Idle, viewModel.uiState.value.loadState)
            assertNull(viewModel.selectedResultForDetail())
        } finally {
            advanceUntilIdle()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `privacy withdrawal revokes gate and allows a new consent initialization`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = ImmediateRecommendationApi()
            val viewModel = viewModel(api)
            viewModel.ensureConsentSessionStarted()
            advanceUntilIdle()
            assertEquals(1, api.featureConfigCalls)

            viewModel.clearForPrivacyWithdrawal()
            assertEquals(
                com.chishenme.app.feature.config.RuntimeAppVersionGate.Status.UNKNOWN,
                viewModel.runtimeAppVersionGate.currentState.status,
            )
            assertNull(viewModel.runtimeAppVersionGate.acquireRemoteAccessLease())

            viewModel.ensureConsentSessionStarted()
            advanceUntilIdle()
            assertEquals(2, api.featureConfigCalls)
            assertNotNull(viewModel.runtimeAppVersionGate.acquireRemoteAccessLease())
        } finally {
            advanceUntilIdle()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `refresh start synchronously clears a ready recommendation session`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = viewModel(ImmediateRecommendationApi())
            viewModel.startConsentSession()
            advanceUntilIdle()
            viewModel.setLocation(BeijingPilotLocations.choices.first())
            assertTrue(viewModel.recommend())
            advanceUntilIdle()
            assertTrue(viewModel.uiState.value.loadState is RecommendationLoadState.Ready)
            val resultToken = currentRecommendationResponse().results.single().resultToken
            assertEquals(ResultSessionState.CURRENT, viewModel.recommendationSessionState(resultToken))

            viewModel.startConsentSession()

            assertEquals(RecommendationLoadState.Idle, viewModel.uiState.value.loadState)
            assertEquals(
                ResultSessionState.CONFIG_UNCONFIRMED,
                viewModel.recommendationSessionState(resultToken),
            )
            advanceUntilIdle()
            assertEquals(ResultSessionState.EXPIRED, viewModel.recommendationSessionState(resultToken))
        } finally {
            advanceUntilIdle()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `refresh invalidates a non cooperative late recommendation response`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val api = LateRecommendationApi()
        try {
            val viewModel = viewModel(api)
            viewModel.startConsentSession()
            advanceUntilIdle()
            viewModel.setLocation(BeijingPilotLocations.choices.first())
            assertTrue(viewModel.recommend())
            runCurrent()
            assertTrue(api.recommendationStarted.isCompleted)
            assertEquals(RecommendationLoadState.Loading, viewModel.uiState.value.loadState)

            viewModel.startConsentSession()

            assertEquals(RecommendationLoadState.Idle, viewModel.uiState.value.loadState)
            api.releaseRecommendation()
            advanceUntilIdle()
            assertEquals(RecommendationLoadState.Idle, viewModel.uiState.value.loadState)
        } finally {
            api.releaseRecommendationIfNeeded()
            advanceUntilIdle()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `older non cooperative config success cannot replace newer fail closed refresh`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val api = LateFirstFeatureConfigApi()
        try {
            val viewModel = viewModel(api)

            viewModel.startConsentSession()
            runCurrent()
            assertTrue(api.firstStarted.isCompleted)
            assertTrue(viewModel.uiState.value.remoteFeatureConfig is RemoteFeatureConfigState.Loading)

            viewModel.startConsentSession()
            runCurrent()
            assertNull(viewModel.uiState.value.featureConfig)
            val unavailable = viewModel.uiState.value.remoteFeatureConfig
            assertTrue(unavailable is RemoteFeatureConfigState.Unavailable)
            assertEquals(
                viewModel.runtimeAppVersionGate.currentState.observedConfigurationGeneration,
                (unavailable as RemoteFeatureConfigState.Unavailable).generation,
            )
            assertEquals(
                "远程配置暂不可用，AI 已按安全默认值关闭",
                viewModel.uiState.value.transientMessage,
            )

            api.releaseFirst()
            runCurrent()

            assertNull(viewModel.uiState.value.featureConfig)
            assertEquals(
                "远程配置暂不可用，AI 已按安全默认值关闭",
                viewModel.uiState.value.transientMessage,
            )
        } finally {
            api.releaseFirstIfNeeded()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `older view model cannot publish config after a newer view model owns the process gate`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val sharedGate = RuntimeAppVersionGate("0.1.0")
        val olderApi = LateFirstFeatureConfigApi()
        try {
            val olderViewModel = viewModel(olderApi, runtimeAppVersionGate = sharedGate)
            olderViewModel.startConsentSession()
            runCurrent()
            assertTrue(olderApi.firstStarted.isCompleted)
            val olderLoading = olderViewModel.uiState.value.remoteFeatureConfig
                as RemoteFeatureConfigState.Loading

            val newerViewModel = viewModel(
                ImmediateRecommendationApi(),
                runtimeAppVersionGate = sharedGate,
            )
            newerViewModel.startConsentSession()
            advanceUntilIdle()
            val newerReady = newerViewModel.uiState.value.remoteFeatureConfig
                as RemoteFeatureConfigState.Ready
            assertTrue(newerReady.generation > olderLoading.generation)
            assertEquals(
                newerReady.generation,
                sharedGate.currentState.trustedConfigurationGeneration,
            )

            olderApi.releaseFirst()
            runCurrent()

            assertEquals(
                RuntimeAppVersionGate.Status.COMPATIBLE,
                sharedGate.currentState.status,
            )
            assertEquals(
                newerReady.generation,
                sharedGate.currentState.trustedConfigurationGeneration,
            )
            assertEquals(
                olderLoading,
                olderViewModel.uiState.value.remoteFeatureConfig,
            )
            assertNull(olderViewModel.uiState.value.featureConfig)
            assertEquals(
                newerReady,
                newerViewModel.uiState.value.remoteFeatureConfig,
            )
        } finally {
            olderApi.releaseFirstIfNeeded()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `fail closed config keeps guest restaurant decision available without AI`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = GuestDecisionApi()
            val viewModel = viewModel(api)

            viewModel.startConsentSession()
            runCurrent()
            assertNull(viewModel.uiState.value.featureConfig)

            viewModel.setLocation(BeijingPilotLocations.choices.first())
            assertTrue(viewModel.recommend())
            runCurrent()

            assertEquals(1, api.recommendCalls)
            assertFalse(requireNotNull(api.lastRecommendation).aiAssistanceEnabled)
            val ready = viewModel.uiState.value.loadState as RecommendationLoadState.Ready
            assertFalse(ready.trustedCompatibleConfiguration)
            val result = currentRecommendationResponse().results.single()
            assertEquals(
                ResultSessionState.EXPIRED,
                viewModel.recommendationSessionState(result.resultToken),
            )
            assertFalse(viewModel.selectResultForDetail(result.resultToken))

            viewModel.recordEvent(result, com.chishenme.app.data.remote.RecommendationEventType.DETAIL)
            viewModel.reroll()
            runCurrent()

            assertEquals(2, api.recommendCalls)
            assertEquals(0, api.eventCalls)
            assertTrue(viewModel.uiState.value.loadState is RecommendationLoadState.Ready)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `minimum version gate blocks recommendation retries reroll and location search`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = MinimumVersionRecommendationApi()
            val locationApi = CountingLocationSearchApi()
            val viewModel = viewModel(api, locationApi)

            viewModel.startConsentSession()
            advanceUntilIdle()
            assertEquals(
                com.chishenme.app.feature.config.RuntimeAppVersionGate.Status.UPDATE_REQUIRED,
                viewModel.runtimeAppVersionGate.currentState.status,
            )

            viewModel.setLocation(BeijingPilotLocations.choices.first())
            assertFalse(viewModel.recommend())
            viewModel.retry()
            viewModel.reroll()
            viewModel.openLocationChooser()
            viewModel.updateLocationSearchQuery("北京大学")
            viewModel.searchLocation()
            advanceUntilIdle()

            assertEquals(0, api.recommendCalls)
            assertEquals(0, api.eventCalls)
            assertEquals(0, locationApi.searchCalls)
            assertEquals(RecommendationLoadState.Idle, viewModel.uiState.value.loadState)
            assertTrue(viewModel.uiState.value.locationSearchState is LocationSearchUiState.Failed)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `trusted compatible recovery clears required update messages`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = RaisingThenCompatibleRecommendationApi()
            val viewModel = viewModel(api)

            viewModel.startConsentSession()
            advanceUntilIdle()

            assertEquals(
                RuntimeAppVersionGate.Status.UPDATE_REQUIRED,
                viewModel.runtimeAppVersionGate.currentState.status,
            )
            assertEquals(REQUIRED_UPDATE_MESSAGE, viewModel.uiState.value.transientMessage)
            assertEquals(REQUIRED_UPDATE_MESSAGE, viewModel.uiState.value.formError)

            viewModel.startConsentSession()
            advanceUntilIdle()

            assertEquals(2, api.featureConfigCalls)
            assertEquals(
                RuntimeAppVersionGate.Status.COMPATIBLE,
                viewModel.runtimeAppVersionGate.currentState.status,
            )
            val ready = viewModel.uiState.value.remoteFeatureConfig as RemoteFeatureConfigState.Ready
            assertEquals("0.1.0", ready.config.minimumSupportedVersion)
            assertNull(viewModel.uiState.value.transientMessage)
            assertNull(viewModel.uiState.value.formError)
        } finally {
            advanceUntilIdle()
            Dispatchers.resetMain()
        }
    }

    private fun viewModel(
        api: RecommendationApi,
        locationSearchApi: LocationSearchApi = FeatureRefreshUnusedLocationSearchApi,
        runtimeAppVersionGate: RuntimeAppVersionGate =
            com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
    ): DecisionViewModel {
        val dataStore = FeatureRefreshPreferencesDataStore()
        return DecisionViewModel(
            repository = RecommendationRepository(api),
            locationSearchRepository = LocationSearchRepository(locationSearchApi),
            preferences = AppPreferences(dataStore),
            historyStore = DecisionHistoryStore(dataStore, Json { ignoreUnknownKeys = true }),
            locationClient = FeatureRefreshUnusedLocationClient,
            runtimeAppVersionGate = runtimeAppVersionGate,
        )
    }

    private companion object {
        const val REQUIRED_UPDATE_MESSAGE =
            "当前版本过低，请更新到 9.0.0 或更高版本"
    }
}

private class MinimumVersionRecommendationApi : RecommendationApi {
    var recommendCalls = 0
    var eventCalls = 0

    override suspend fun featureConfig(): FeatureConfig = currentFeatureConfig().copy(
        minimumSupportedVersion = "9.0.0",
    )

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse {
        recommendCalls += 1
        return currentRecommendationResponse()
    }

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> {
        eventCalls += 1
        return Response.success(Unit)
    }
}

private class ClosedRecommendationApi : RecommendationApi {
    var recommendCalls = 0

    override suspend fun featureConfig(): FeatureConfig = currentFeatureConfig().copy(
        serviceCapabilities = ServiceCapabilities.Disabled,
    )

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse {
        recommendCalls += 1
        return currentRecommendationResponse()
    }

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> =
        Response.success(Unit)
}

private class RaisingThenCompatibleRecommendationApi : RecommendationApi {
    var featureConfigCalls = 0

    override suspend fun featureConfig(): FeatureConfig {
        featureConfigCalls += 1
        return currentFeatureConfig().copy(
            minimumSupportedVersion = if (featureConfigCalls == 1) "9.0.0" else "0.1.0",
        )
    }

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
}

private class CountingLocationSearchApi : LocationSearchApi {
    var searchCalls = 0

    override suspend fun search(request: LocationSearchRequest): LocationSearchResponse {
        searchCalls += 1
        error("minimum-version gate must block location search")
    }
}

private class ImmediateRecommendationApi : RecommendationApi {
    var featureConfigCalls = 0
    var eventCalls = 0

    override suspend fun featureConfig(): FeatureConfig {
        featureConfigCalls += 1
        return currentFeatureConfig()
    }

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse =
        currentRecommendationResponse()

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> {
        eventCalls += 1
        return Response.success(Unit)
    }
}

private class LateRecommendationApi : RecommendationApi {
    val recommendationStarted = CompletableDeferred<Unit>()
    private var recommendationContinuation: Continuation<RecommendationResponse>? = null

    override suspend fun featureConfig(): FeatureConfig = currentFeatureConfig()

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse =
        suspendCoroutine { continuation ->
            recommendationContinuation = continuation
            recommendationStarted.complete(Unit)
        }

    fun releaseRecommendation() {
        checkNotNull(recommendationContinuation).also { continuation ->
            recommendationContinuation = null
            continuation.resume(currentRecommendationResponse())
        }
    }

    fun releaseRecommendationIfNeeded() {
        recommendationContinuation?.also { continuation ->
            recommendationContinuation = null
            continuation.resume(currentRecommendationResponse())
        }
    }

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = Response.success(Unit)
}

private class LateFirstFeatureConfigApi : RecommendationApi {
    val firstStarted = CompletableDeferred<Unit>()
    private var featureConfigCalls = 0
    private var firstContinuation: Continuation<FeatureConfig>? = null

    override suspend fun featureConfig(): FeatureConfig {
        featureConfigCalls += 1
        if (featureConfigCalls > 1) throw IOException("newer refresh is offline")
        return suspendCoroutine { continuation ->
            firstContinuation = continuation
            firstStarted.complete(Unit)
        }
    }

    fun releaseFirst() {
        checkNotNull(firstContinuation).also { continuation ->
            firstContinuation = null
            continuation.resume(staleEnabledConfig())
        }
    }

    fun releaseFirstIfNeeded() {
        firstContinuation?.also { continuation ->
            firstContinuation = null
            continuation.resume(staleEnabledConfig())
        }
    }

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
}

private class GuestDecisionApi : RecommendationApi {
    var recommendCalls = 0
    var eventCalls = 0
    var lastRecommendation: RecommendationContext? = null

    override suspend fun featureConfig(): FeatureConfig = throw IOException("offline")

    override suspend fun recommend(context: RecommendationContext): RecommendationResponse {
        recommendCalls += 1
        lastRecommendation = context
        return currentRecommendationResponse()
    }

    override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> {
        eventCalls += 1
        return Response.success(Unit)
    }
}

private fun staleEnabledConfig() = FeatureConfig(
    coverageName = "不应覆盖较新失败状态",
    dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
    aiEnabled = true,
    accountsEnabled = false,
    favoritesEnabled = false,
    minimumSupportedVersion = "0.1.0",
    ruleVersion = "stale-rule",
    promptVersion = "stale-prompt",
    modelVersion = "stale-model",
    serviceCapabilities = ServiceCapabilities(
        recommendationsEnabled = true,
        locationSearchEnabled = true,
        placeSearchEnabled = true,
    ),
)

private fun currentFeatureConfig() = FeatureConfig(
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
        recommendationsEnabled = true,
        locationSearchEnabled = true,
        placeSearchEnabled = true,
    ),
)

private fun currentRecommendationResponse() = RecommendationResponse(
    requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
    generatedAt = "2026-08-21T04:00:00Z",
    coverage = Coverage.BEIJING_FOURTH_RING,
    dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
    ruleVersion = "rule-v1",
    promptVersion = "prompt-v1",
    modelVersion = "rule-fallback",
    aiFallbackUsed = true,
    results = listOf(
        RecommendationResult(
            provider = "DEMO",
            resultToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            dataMode = RecommendationDataMode.DEMO,
            actions = RecommendationActions(
                navigate = true,
                call = true,
                copyAddress = true,
                share = true,
            ),
            name = "演示面馆",
            address = "北京市海淀区测试路 1 号",
            rank = 1,
            fitScore = null,
            sourceRating = 4.5,
            averageCostYuan = 25.0,
            distanceMeters = 520.0,
            estimatedTravelMinutes = 8.0,
            estimatedMealMinutes = 22.0,
            openStatus = OpenStatus.OPEN,
            tags = listOf("面食"),
            imageUrl = null,
            phone = null,
            location = Coordinate(
                latitude = 39.99,
                longitude = 116.31,
                crs = CoordinateReferenceSystem.WGS84,
            ),
            reasons = listOf(RecommendationReason(ReasonCode.DISTANCE_FIT, "距离符合要求")),
            warnings = emptyList(),
            confidence = Confidence.HIGH,
            aiAssisted = false,
            sourceAttribution = "演示数据",
        ),
    ),
    notice = null,
)

private class FeatureRefreshPreferencesDataStore : DataStore<Preferences> {
    private val state = MutableStateFlow<Preferences>(emptyPreferences())
    override val data: Flow<Preferences> = state

    override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
        transform(state.value).also { state.value = it }
}

private object FeatureRefreshUnusedLocationSearchApi : LocationSearchApi {
    override suspend fun search(request: LocationSearchRequest): LocationSearchResponse = error("unused")
}

private object FeatureRefreshUnusedLocationClient : ForegroundLocationClient {
    override suspend fun currentLocation(): ForegroundLocationResult = error("unused")
}
