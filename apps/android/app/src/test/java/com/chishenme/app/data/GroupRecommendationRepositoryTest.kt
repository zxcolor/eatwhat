package com.chishenme.app.data

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.GroupConstraintAggregation
import com.chishenme.app.data.remote.GroupRecommendationApi
import com.chishenme.app.data.remote.GroupRecommendationMemberConstraints
import com.chishenme.app.data.remote.GroupRecommendationRequest
import com.chishenme.app.data.remote.GroupRecommendationResponse
import com.chishenme.app.data.remote.GroupRecommendationResult
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.ReasonCode
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.TravelMode
import java.net.UnknownHostException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class GroupRecommendationRepositoryTest {
    private val request = GroupRecommendationRequest(
        location = Coordinate(39.9, 116.4, 50.0, CoordinateReferenceSystem.WGS84),
        travelMode = TravelMode.WALK,
        members = List(2) {
            GroupRecommendationMemberConstraints(null, 60, 1_500, emptyList(), emptyList())
        },
    )
    private val aggregation = GroupConstraintAggregation(
        "group-constraints-v1",
        2,
        null,
        60,
        1_500,
        emptyList(),
        emptyList(),
    )

    @Test
    fun `valid display response succeeds`() = runTest {
        val expected = response()
        val repository = GroupRecommendationRepository(api { expected })

        val outcome = repository.recommend(
            request,
            aggregation,
            DataRightsMode.LIVE_DISPLAY_ONLY,
            "rule-v2",
        )

        assertTrue(outcome is GroupRecommendationOutcome.Success)
        assertSame(expected, (outcome as GroupRecommendationOutcome.Success).response)
    }

    @Test
    fun `server aggregation mismatch is classified invalid and hidden`() = runTest {
        val repository = GroupRecommendationRepository(
            api { response().copy(aggregation = aggregation.copy(effectiveRadiusMeters = 900)) },
        )

        val outcome = repository.recommend(
            request,
            aggregation,
            DataRightsMode.LIVE_DISPLAY_ONLY,
            "rule-v2",
        )

        assertEquals(
            GroupRecommendationFailureKind.INVALID_RESPONSE,
            (outcome as GroupRecommendationOutcome.Failure).kind,
        )
    }

    @Test
    fun `network failure is bounded and cancellation is never swallowed`() = runTest {
        val network = GroupRecommendationRepository(api { throw UnknownHostException() })
            .recommend(
                request,
                aggregation,
                DataRightsMode.LIVE_DISPLAY_ONLY,
                "rule-v2",
            ) as GroupRecommendationOutcome.Failure
        assertEquals(GroupRecommendationFailureKind.NETWORK, network.kind)

        val cancellation = CancellationException("cancelled")
        try {
            GroupRecommendationRepository(api { throw cancellation }).recommend(
                request,
                aggregation,
                DataRightsMode.LIVE_DISPLAY_ONLY,
                "rule-v2",
            )
            throw AssertionError("Expected cancellation")
        } catch (actual: CancellationException) {
            assertSame(cancellation, actual)
        }
    }

    private fun api(block: suspend () -> GroupRecommendationResponse) =
        object : GroupRecommendationApi {
            override suspend fun recommend(request: GroupRecommendationRequest): GroupRecommendationResponse =
                block()
        }

    private fun response() = GroupRecommendationResponse(
        requestId = "123e4567-e89b-42d3-a456-426614174000",
        generatedAt = "2026-09-03T10:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-v2",
        aggregation = aggregation,
        results = listOf(
            GroupRecommendationResult(
                provider = "DEMO",
                dataMode = RecommendationDataMode.DEMO,
                name = "群组候选一号",
                address = "虚构测试地址",
                rank = 1,
                fitScore = null,
                sourceRating = 4.2,
                averageCostYuan = 30.0,
                distanceMeters = 500.0,
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
}
