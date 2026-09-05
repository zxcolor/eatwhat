package com.chishenme.app.feature.group

import com.chishenme.app.data.GroupRecommendationRepository
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.GroupConstraintAggregation
import com.chishenme.app.data.remote.GroupRecommendationApi
import com.chishenme.app.data.remote.GroupRecommendationRequest
import com.chishenme.app.data.remote.GroupRecommendationResponse
import com.chishenme.app.data.remote.GroupRecommendationResult
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.ReasonCode
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.ServiceCapabilities
import com.chishenme.app.domain.GroupConstraintAggregator
import com.chishenme.app.domain.GroupMemberConstraints
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GroupDecisionViewModelTest {
    private val location = Coordinate(
        latitude = 39.9,
        longitude = 116.4,
        accuracyMeters = 50.0,
        crs = CoordinateReferenceSystem.WGS84,
    )

    @Test
    fun `direct start and guest recommendation fallback cannot open group flow`() = runTest {
        withMainDispatcher(testScheduler) {
            val api = RecordingGroupApi()
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = viewModel(api, gate)

            assertFalse(viewModel.start())

            val generation = gate.beginConfigurationRefresh()
            gate.markConfigurationUnavailable(generation)
            viewModel.applyFeatureConfig(enabledConfig(), generation)
            assertFalse(viewModel.start())
            assertEquals(GroupDecisionPhase.CLOSED, viewModel.state.value.phase)
            assertFalse(viewModel.state.value.capabilityAvailable)
            assertEquals(0, api.requests.size)
        }
    }

    @Test
    fun `missing or false group capability stays closed under trusted config`() = runTest {
        withMainDispatcher(testScheduler) {
            val gate = RuntimeAppVersionGate("1.0.0")
            val api = RecordingGroupApi()
            val viewModel = viewModel(api, gate)
            val generation = trust(gate)

            viewModel.applyFeatureConfig(
                enabledConfig().copy(
                    serviceCapabilities = ServiceCapabilities(
                        recommendationsEnabled = true,
                        groupRecommendationsEnabled = false,
                    ),
                ),
                generation,
            )
            assertFalse(viewModel.start())

            viewModel.applyFeatureConfig(
                enabledConfig().copy(serviceCapabilities = null),
                generation,
            )
            assertFalse(viewModel.start())
            assertEquals(0, api.requests.size)
        }
    }

    @Test
    fun `trusted capability drives two-member edit review submit and exact request`() = runTest {
        withMainDispatcher(testScheduler) {
            val api = RecordingGroupApi()
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = authorizedViewModel(api, gate)

            assertTrue(viewModel.start())
            assertEquals(GroupDecisionPhase.EDITING, viewModel.state.value.phase)
            assertTrue(viewModel.setLocation(location))
            assertTrue(
                viewModel.updateMember(
                    0,
                    member(
                        budget = null,
                        minutes = 90,
                        radius = 2_000,
                        preferred = setOf("面食", "米饭"),
                    ),
                ),
            )
            assertTrue(viewModel.confirmCurrentMember())
            assertEquals(1, viewModel.state.value.activeMemberIndex)
            assertTrue(
                viewModel.updateMember(
                    1,
                    member(
                        budget = 35,
                        minutes = 45,
                        radius = 800,
                        preferred = setOf("面食"),
                        excluded = setOf("米饭"),
                    ),
                ),
            )
            assertTrue(viewModel.confirmCurrentMember())
            assertTrue(viewModel.review())

            val summary = requireNotNull(viewModel.state.value.aggregation)
            assertEquals(35, summary.effectiveBudgetMaxYuan)
            assertEquals(45, summary.effectiveAvailableMinutes)
            assertEquals(800, summary.effectiveRadiusMeters)
            assertEquals(listOf("面食"), summary.preferredCuisines)
            assertEquals(listOf("米饭"), summary.excludedCuisines)
            assertNull(viewModel.state.value.response)

            assertTrue(viewModel.submit())
            advanceUntilIdle()

            assertEquals(GroupDecisionPhase.RESULT, viewModel.state.value.phase)
            assertEquals(1, api.requests.size)
            val request = api.requests.single()
            assertEquals(location, request.location)
            assertEquals(2, request.members.size)
            assertEquals(null, request.members[0].budgetMaxYuan)
            assertEquals(35, request.members[1].budgetMaxYuan)
            assertEquals(listOf("面食", "米饭"), request.members[0].preferredCuisines)
        }
    }

    @Test
    fun `state machine supports eight positional members but rejects one and nine`() = runTest {
        withMainDispatcher(testScheduler) {
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = authorizedViewModel(RecordingGroupApi(), gate)
            assertTrue(viewModel.start())

            assertFalse(viewModel.setMemberCount(1))
            assertFalse(viewModel.setMemberCount(9))
            assertTrue(viewModel.setMemberCount(8))
            assertEquals(8, viewModel.state.value.input.members.size)
            assertEquals(List(8) { false }, viewModel.state.value.confirmedMembers)

            for (index in 0 until 8) {
                assertTrue(viewModel.selectMember(index))
                assertTrue(viewModel.confirmCurrentMember())
            }
            assertFalse(viewModel.review())
            assertTrue(viewModel.setLocation(location))
            assertTrue(viewModel.review())
            assertEquals(GroupDecisionPhase.REVIEW, viewModel.state.value.phase)
        }
    }

    @Test
    fun `editing a confirmed member revokes its confirmation and prevents review`() = runTest {
        withMainDispatcher(testScheduler) {
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = authorizedViewModel(RecordingGroupApi(), gate)
            viewModel.start()
            viewModel.setLocation(location)
            viewModel.confirmCurrentMember()
            viewModel.confirmCurrentMember()
            assertTrue(viewModel.state.value.confirmedMembers.all { it })

            viewModel.updateMember(0, member(budget = 20))

            assertEquals(listOf(false, true), viewModel.state.value.confirmedMembers)
            assertFalse(viewModel.review())
            assertEquals(GroupDecisionPhase.EDITING, viewModel.state.value.phase)
        }
    }

    @Test
    fun `summary mismatch is rejected before any result becomes visible`() = runTest {
        withMainDispatcher(testScheduler) {
            val api = RecordingGroupApi { request ->
                validResponse(request).copy(
                    aggregation = aggregation(request).copy(effectiveRadiusMeters = 999),
                )
            }
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = authorizedViewModel(api, gate)
            prepareReview(viewModel)

            assertTrue(viewModel.submit())
            advanceUntilIdle()

            assertEquals(GroupDecisionPhase.FAILED, viewModel.state.value.phase)
            assertNull(viewModel.state.value.response)
            assertTrue(viewModel.state.value.formError.orEmpty().contains("共同条件校验"))
        }
    }

    @Test
    fun `session binds response rights mode and rule version to trusted config`() = runTest {
        withMainDispatcher(testScheduler) {
            val licensedResponseApi = RecordingGroupApi { request ->
                validResponse(request).copy(
                    dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT,
                    results = validResponse(request).results.map { it.copy(fitScore = 88.0) },
                )
            }
            val liveGate = RuntimeAppVersionGate("1.0.0")
            val liveViewModel = authorizedViewModel(licensedResponseApi, liveGate)
            prepareReview(liveViewModel)
            liveViewModel.submit()
            advanceUntilIdle()
            assertEquals(GroupDecisionPhase.FAILED, liveViewModel.state.value.phase)
            assertNull(liveViewModel.state.value.response)

            val wrongRuleApi = RecordingGroupApi { request ->
                validResponse(request).copy(ruleVersion = "wrong-rule-v3")
            }
            val ruleGate = RuntimeAppVersionGate("1.0.0")
            val ruleViewModel = authorizedViewModel(wrongRuleApi, ruleGate)
            prepareReview(ruleViewModel)
            ruleViewModel.submit()
            advanceUntilIdle()
            assertEquals(GroupDecisionPhase.FAILED, ruleViewModel.state.value.phase)
            assertNull(ruleViewModel.state.value.response)

            val licensedGate = RuntimeAppVersionGate("1.0.0")
            val licensedViewModel = authorizedViewModel(
                licensedResponseApi,
                licensedGate,
                enabledConfig().copy(dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT),
            )
            prepareReview(licensedViewModel)
            licensedViewModel.submit()
            advanceUntilIdle()
            assertEquals(GroupDecisionPhase.RESULT, licensedViewModel.state.value.phase)
            assertEquals(
                DataRightsMode.LICENSED_ENRICHMENT,
                licensedViewModel.state.value.response?.dataRightsMode,
            )
        }
    }

    @Test
    fun `retry uses the exact in-memory conditions and never retains result identity`() = runTest {
        withMainDispatcher(testScheduler) {
            val api = RecordingGroupApi()
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = authorizedViewModel(api, gate)
            prepareReview(viewModel)
            viewModel.submit()
            advanceUntilIdle()
            val firstResponse = requireNotNull(viewModel.state.value.response)

            assertTrue(viewModel.retry())
            advanceUntilIdle()

            assertEquals(2, api.requests.size)
            assertEquals(api.requests[0], api.requests[1])
            assertTrue(firstResponse.requestId != viewModel.state.value.response?.requestId)
        }
    }

    @Test
    fun `configuration generation change clears all memory and discards uncooperative late response`() = runTest {
        withMainDispatcher(testScheduler) {
            val api = LateGroupApi()
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = authorizedViewModel(api, gate)
            prepareReview(viewModel)
            viewModel.submit()
            runCurrent()
            assertEquals(GroupDecisionPhase.SUBMITTING, viewModel.state.value.phase)

            val nextGeneration = gate.beginConfigurationRefresh()
            viewModel.applyFeatureConfig(null, nextGeneration)
            assertCleared(viewModel)

            api.resume(validResponse(requireNotNull(api.request)))
            runCurrent()

            assertCleared(viewModel)
        }
    }

    @Test
    fun `runtime gate revocation alone clears an active result session`() = runTest {
        withMainDispatcher(testScheduler) {
            val api = RecordingGroupApi()
            val gate = RuntimeAppVersionGate("1.0.0")
            val viewModel = authorizedViewModel(api, gate)
            prepareReview(viewModel)
            viewModel.submit()
            advanceUntilIdle()
            assertEquals(GroupDecisionPhase.RESULT, viewModel.state.value.phase)

            gate.beginConfigurationRefresh()
            runCurrent()

            assertCleared(viewModel)
        }
    }

    @Test
    fun `privacy exit and real background each clear input result and authority`() = runTest {
        withMainDispatcher(testScheduler) {
            val clearers = listOf<(GroupDecisionViewModel) -> Unit>(
                { it.clearForPrivacyWithdrawal() },
                { it.clearForExit() },
                { it.clearForBackground() },
                { it.clear() },
            )
            clearers.forEach { clear ->
                val api = RecordingGroupApi()
                val gate = RuntimeAppVersionGate("1.0.0")
                val viewModel = authorizedViewModel(api, gate)
                prepareReview(viewModel)
                viewModel.submit()
                advanceUntilIdle()
                clear(viewModel)

                assertCleared(viewModel)
                assertFalse(viewModel.start())
            }
        }
    }

    @Test
    fun `constructor has no persistence account saved-state or ordinary decision dependencies`() {
        val parameterTypes = GroupDecisionViewModel::class.java.declaredConstructors
            .flatMap { it.parameterTypes.toList() }
            .map(Class<*>::getName)
        val forbiddenSuffixes = listOf(
            ".SavedStateHandle",
            ".AppPreferences",
            ".DecisionHistoryStore",
            ".AuthRepository",
            ".SavedResourcesRepository",
            ".RecommendationRepository",
        )

        assertTrue(parameterTypes.any { it.endsWith("GroupRecommendationRepository") })
        assertTrue(parameterTypes.any { it.endsWith("RuntimeAppVersionGate") })
        assertTrue(parameterTypes.none { type -> forbiddenSuffixes.any(type::endsWith) })
    }

    private suspend fun prepareReview(viewModel: GroupDecisionViewModel) {
        assertTrue(viewModel.start())
        assertTrue(viewModel.setLocation(location))
        assertTrue(viewModel.confirmCurrentMember())
        assertTrue(viewModel.confirmCurrentMember())
        assertTrue(viewModel.review())
    }

    private fun authorizedViewModel(
        api: GroupRecommendationApi,
        gate: RuntimeAppVersionGate,
        config: FeatureConfig = enabledConfig(),
    ): GroupDecisionViewModel {
        val viewModel = viewModel(api, gate)
        val generation = trust(gate)
        viewModel.applyFeatureConfig(config, generation)
        return viewModel
    }

    private fun viewModel(
        api: GroupRecommendationApi,
        gate: RuntimeAppVersionGate,
    ) = GroupDecisionViewModel(GroupRecommendationRepository(api), gate)

    private fun trust(gate: RuntimeAppVersionGate): Long = gate.beginConfigurationRefresh().also {
        gate.acceptTrustedConfiguration(it, "1.0.0")
    }

    private fun enabledConfig() = FeatureConfig(
        coverageName = "全国服务",
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        aiEnabled = false,
        accountsEnabled = false,
        favoritesEnabled = false,
        minimumSupportedVersion = "1.0.0",
        ruleVersion = "rule-v2",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback-v1",
        serviceCapabilities = ServiceCapabilities(
            recommendationsEnabled = true,
            groupRecommendationsEnabled = true,
        ),
    )

    private fun member(
        budget: Int? = null,
        minutes: Int = 60,
        radius: Int = 1_500,
        preferred: Set<String> = emptySet(),
        excluded: Set<String> = emptySet(),
    ) = GroupMemberConstraints(
        budgetMaxYuan = budget,
        availableMinutes = minutes,
        radiusMeters = radius,
        preferredCuisines = preferred,
        excludedCuisines = excluded,
    )

    private fun assertCleared(viewModel: GroupDecisionViewModel) {
        val state = viewModel.state.value
        assertEquals(GroupDecisionPhase.CLOSED, state.phase)
        assertFalse(state.capabilityAvailable)
        assertNull(state.input.location)
        assertEquals(2, state.input.members.size)
        assertEquals(List(2) { false }, state.confirmedMembers)
        assertNull(state.aggregation)
        assertNull(state.response)
    }

    private suspend fun withMainDispatcher(
        scheduler: TestCoroutineScheduler,
        block: suspend () -> Unit,
    ) {
        val dispatcher = StandardTestDispatcher(scheduler)
        Dispatchers.setMain(dispatcher)
        try {
            block()
        } finally {
            Dispatchers.resetMain()
        }
    }
}

private class RecordingGroupApi(
    private val responseFactory: (GroupRecommendationRequest) -> GroupRecommendationResponse =
        ::validResponse,
) : GroupRecommendationApi {
    val requests = mutableListOf<GroupRecommendationRequest>()

    override suspend fun recommend(request: GroupRecommendationRequest): GroupRecommendationResponse {
        requests += request
        return responseFactory(request)
    }
}

private class LateGroupApi : GroupRecommendationApi {
    var request: GroupRecommendationRequest? = null
    private var continuation: Continuation<GroupRecommendationResponse>? = null

    override suspend fun recommend(request: GroupRecommendationRequest): GroupRecommendationResponse =
        suspendCoroutine { continuation ->
            this.request = request
            this.continuation = continuation
        }

    fun resume(response: GroupRecommendationResponse) {
        requireNotNull(continuation).resume(response)
    }
}

private var responseSequence = 0

private fun validResponse(request: GroupRecommendationRequest): GroupRecommendationResponse =
    GroupRecommendationResponse(
        requestId = "123e4567-e89b-42d3-a456-${(426614174000L + responseSequence++).toString().padStart(12, '0')}",
        generatedAt = "2026-09-03T10:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-v2",
        aggregation = aggregation(request),
        results = listOf(
            GroupRecommendationResult(
                provider = "DEMO",
                dataMode = RecommendationDataMode.DEMO,
                name = "群组候选一号",
                address = "虚构测试地址",
                rank = 1,
                fitScore = null,
                sourceRating = 4.2,
                averageCostYuan = request.members.mapNotNull { it.budgetMaxYuan }.minOrNull()
                    ?.coerceAtMost(30)?.toDouble(),
                distanceMeters = request.members.minOf { it.radiusMeters }.coerceAtMost(500).toDouble(),
                estimatedTravelMinutes = 8.0,
                estimatedMealMinutes = 30.0,
                openStatus = OpenStatus.OPEN,
                tags = listOf("面食"),
                reasons = listOf(RecommendationReason(ReasonCode.TIME_FIT, "符合共同时间范围")),
                warnings = emptyList(),
                confidence = Confidence.MEDIUM,
                sourceAttribution = "虚构演示数据",
            ),
        ),
        notice = null,
    )

private fun aggregation(request: GroupRecommendationRequest): GroupConstraintAggregation {
    val members = request.members.map { member ->
        GroupMemberConstraints(
            budgetMaxYuan = member.budgetMaxYuan,
            availableMinutes = member.availableMinutes,
            radiusMeters = member.radiusMeters,
            preferredCuisines = member.preferredCuisines.toSet(),
            excludedCuisines = member.excludedCuisines.toSet(),
        )
    }
    return GroupConstraintAggregator.aggregate(members)
}
