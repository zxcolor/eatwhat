package com.chishenme.app.feature.search

import com.chishenme.app.data.PlaceSearchRepository
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.PlaceSearchApi
import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchRequest
import com.chishenme.app.data.remote.PlaceSearchResponse
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.domain.DecisionInput
import com.chishenme.app.domain.LocationChoice
import com.chishenme.app.feature.session.ResultSessionState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PlaceSearchLifecycleTest {
    @Test
    fun `enabled capability from an older config generation cannot authorize new transport`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LatePlaceSearchApi()
            val gate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(1)
            val viewModel = PlaceSearchViewModel(PlaceSearchRepository(api), gate)
            viewModel.updateKeyword("面")
            val staleAuthority = PlaceSearchCapabilityAuthority(1, enabled = true)
            gate.markConfigurationUntrusted(2)
            gate.acceptTrustedConfiguration(2, "0.1.0")

            viewModel.search(input(), staleAuthority)
            runCurrent()

            assertFalse(api.started.isCompleted)
            assertTrue(viewModel.state.value.loadState is PlaceSearchLoadState.Failed)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `closed provider capability blocks transport before repository access`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LatePlaceSearchApi()
            val viewModel = PlaceSearchViewModel(
                PlaceSearchRepository(api),
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )
            viewModel.updateKeyword("面")

            viewModel.search(input(), PlaceSearchCapabilityAuthority(1, enabled = false))
            runCurrent()

            assertFalse(api.started.isCompleted)
            assertTrue(viewModel.state.value.loadState is PlaceSearchLoadState.Failed)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `unknown runtime gate blocks search and retry before repository access`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LatePlaceSearchApi()
            val gate = com.chishenme.app.feature.config.RuntimeAppVersionGate("0.1.0").apply {
                markConfigurationUntrusted(1)
            }
            val viewModel = PlaceSearchViewModel(PlaceSearchRepository(api), gate)
            viewModel.updateKeyword("面")

            viewModel.search(input(), PlaceSearchCapabilityAuthority(1, enabled = true))
            viewModel.retry(PlaceSearchCapabilityAuthority(1, enabled = true))
            runCurrent()

            assertFalse(api.started.isCompleted)
            assertEquals(PlaceSearchUiState(), viewModel.state.value)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `runtime refresh clears session and discards a non cooperative late response`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val api = LatePlaceSearchApi()
        try {
            val gate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate()
            val viewModel = PlaceSearchViewModel(PlaceSearchRepository(api), gate)
            viewModel.updateKeyword("面")
            viewModel.search(input(), PlaceSearchCapabilityAuthority(1, enabled = true))
            runCurrent()
            assertTrue(api.started.isCompleted)

            gate.markConfigurationUntrusted(2)
            runCurrent()
            assertEquals(PlaceSearchUiState(), viewModel.state.value)

            api.release.complete(Unit)
            advanceUntilIdle()
            assertEquals(PlaceSearchUiState(), viewModel.state.value)
        } finally {
            if (!api.release.isCompleted) api.release.complete(Unit)
            advanceUntilIdle()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `clear session prevents a non cooperative late response from restoring results`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LatePlaceSearchApi()
            val viewModel = PlaceSearchViewModel(
                PlaceSearchRepository(api),
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )
            viewModel.updateKeyword("面")
            viewModel.search(input(), PlaceSearchCapabilityAuthority(1, enabled = true))
            runCurrent()
            assertTrue(api.started.isCompleted)
            assertEquals(PlaceSearchLoadState.Loading, viewModel.state.value.loadState)

            viewModel.clearSession()

            assertEquals("", viewModel.state.value.keyword)
            assertNull(viewModel.state.value.keywordError)
            assertEquals(PlaceSearchLoadState.Idle, viewModel.state.value.loadState)
            api.release.complete(Unit)
            advanceUntilIdle()
            assertEquals("", viewModel.state.value.keyword)
            assertEquals(PlaceSearchLoadState.Idle, viewModel.state.value.loadState)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `cancel prevents a non cooperative late response from restoring results`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = LatePlaceSearchApi()
            val viewModel = PlaceSearchViewModel(
                PlaceSearchRepository(api),
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )
            viewModel.updateKeyword("面")
            viewModel.search(input(), PlaceSearchCapabilityAuthority(1, enabled = true))
            runCurrent()
            assertTrue(api.started.isCompleted)
            assertEquals(PlaceSearchLoadState.Loading, viewModel.state.value.loadState)

            viewModel.cancelInFlight()
            assertEquals(PlaceSearchLoadState.Idle, viewModel.state.value.loadState)
            api.release.complete(Unit)
            advanceUntilIdle()

            assertEquals(PlaceSearchLoadState.Idle, viewModel.state.value.loadState)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `request uses current session facts and clear removes the memory session`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var captured: PlaceSearchRequest? = null
            val api = object : PlaceSearchApi {
                override suspend fun search(request: PlaceSearchRequest): PlaceSearchResponse {
                    captured = request
                    return PlaceSearchResponse(
                        requestId = "11111111-1111-4111-8111-111111111111",
                        coverage = Coverage.BEIJING_FOURTH_RING,
                        results = listOf(searchResult()),
                        notice = null,
                    )
                }
            }
            val viewModel = PlaceSearchViewModel(
                PlaceSearchRepository(api),
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )
            viewModel.updateKeyword(" 粥 ")
            viewModel.setOpenNow(true)
            viewModel.search(input(), PlaceSearchCapabilityAuthority(1, enabled = true))
            advanceUntilIdle()

            assertEquals("粥", captured?.keyword)
            assertEquals(MealPeriod.LUNCH, captured?.mealPeriod)
            assertEquals(1_500, captured?.radiusMeters)
            assertEquals(25, captured?.maxAverageCostYuan)
            assertEquals(true, captured?.openNow)
            assertEquals(CoordinateReferenceSystem.WGS84, captured?.location?.crs)
            assertEquals(
                ResultSessionState.CURRENT,
                viewModel.resultSessionState(searchResult().resultToken),
            )
            assertFalse(viewModel.selectResultForDetail("not-current-token"))
            assertTrue(viewModel.selectResultForDetail(searchResult().resultToken))
            assertEquals(
                searchResult().resultToken,
                viewModel.selectedResultForDetail()?.resultToken,
            )

            // Navigating from the result list disposes that screen and cancels
            // transport ownership. It must not destroy the completed result
            // lease needed by the in-memory detail destination.
            viewModel.cancelInFlight()
            assertEquals(
                ResultSessionState.CURRENT,
                viewModel.resultSessionState(searchResult().resultToken),
            )
            assertEquals(
                searchResult().resultToken,
                viewModel.selectedResultForDetail()?.resultToken,
            )

            viewModel.clearSelectedResult()
            assertNull(viewModel.selectedResultForDetail())
            assertEquals(
                ResultSessionState.CURRENT,
                viewModel.resultSessionState(searchResult().resultToken),
            )

            viewModel.clearSession()
            assertEquals("", viewModel.state.value.keyword)
            assertNull(viewModel.state.value.keywordError)
            assertEquals(PlaceSearchLoadState.Idle, viewModel.state.value.loadState)
            assertEquals(
                ResultSessionState.EXPIRED,
                viewModel.resultSessionState(searchResult().resultToken),
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `search radius is normalized to the contract range`() {
        assertEquals(500, normalizedPlaceSearchRadius(200))
        assertEquals(500, normalizedPlaceSearchRadius(500))
        assertEquals(1_500, normalizedPlaceSearchRadius(1_500))
        assertEquals(5_000, normalizedPlaceSearchRadius(5_000))
        assertEquals(5_000, normalizedPlaceSearchRadius(10_000))
    }

    private fun input() = DecisionInput(
        location = LocationChoice(
            label = "北京大学东门",
            coordinate = Coordinate(39.9928, 116.3109, 50.0, CoordinateReferenceSystem.WGS84),
        ),
        mealPeriod = MealPeriod.LUNCH,
        decisionMode = DecisionMode.QUICK,
        travelMode = TravelMode.WALK,
        explorationMode = ExplorationMode.BALANCED,
        budgetMaxYuan = 25,
        availableMinutes = 60,
        radiusMeters = 1_500,
        partySize = 1,
        excludedCuisines = emptySet(),
        preferredCuisines = emptySet(),
    )
}

private class LatePlaceSearchApi : PlaceSearchApi {
    val started = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()

    override suspend fun search(request: PlaceSearchRequest): PlaceSearchResponse = withContext(NonCancellable) {
        started.complete(Unit)
        release.await()
        PlaceSearchResponse(
            requestId = "11111111-1111-4111-8111-111111111111",
            coverage = Coverage.BEIJING_FOURTH_RING,
            results = emptyList(),
            notice = null,
        )
    }
}

private fun searchResult() = PlaceSearchResult(
    resultToken = "S".repeat(43),
    rank = 1,
    name = "测试面馆",
    address = "北京市海淀区测试路 1 号",
    location = PlaceSearchCoordinate(39.9928, 116.3109, CoordinateReferenceSystem.GCJ02),
    distanceMeters = 300,
    sourceLabel = "授权餐厅数据",
    sourceRating = 4.5,
    averageCostYuan = 20.0,
    openStatus = OpenStatus.OPEN,
    tags = listOf("面食"),
    dataMode = "LIVE",
    actions = RecommendationActions(
        navigate = true,
        call = false,
        copyAddress = true,
        share = true,
    ),
)
