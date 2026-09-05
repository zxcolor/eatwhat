package com.chishenme.app.feature.results

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.ReasonCode
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.TravelMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NearbyOrientationProjectionTest {
    @Test
    fun wgs84OriginIsAlignedPerTargetWithoutMixingCoordinateSystems() {
        val wgsContext = context(CoordinateReferenceSystem.WGS84)
        val mixed = NearbyOrientationProjector.project(
            wgsContext,
            listOf(
                result(1, Coordinate(39.901, 116.4, crs = CoordinateReferenceSystem.WGS84)),
                result(2, Coordinate(39.901, 116.4, crs = CoordinateReferenceSystem.GCJ02)),
            ),
        )

        assertEquals(listOf(1, 2), mixed.points.map(NearbyOrientationPoint::rank))
        assertEquals(0, mixed.skippedCount)
        assertEquals(NearbyDirection.NORTH, mixed.points.first().direction)

        val gcj = NearbyOrientationProjector.project(
            context(CoordinateReferenceSystem.GCJ02),
            listOf(result(1, Coordinate(39.9, 116.401, crs = CoordinateReferenceSystem.GCJ02))),
        )
        assertEquals(1, gcj.points.size)
        assertEquals(NearbyDirection.EAST, gcj.points.single().direction)
    }

    @Test
    fun invalidAndImplausiblyFarCoordinatesAreSkippedWithoutBreakingProjection() {
        val projection = NearbyOrientationProjector.project(
            context(CoordinateReferenceSystem.WGS84),
            listOf(
                result(1, Coordinate(Double.NaN, 116.4, crs = CoordinateReferenceSystem.WGS84)),
                result(2, Coordinate(91.0, 116.4, crs = CoordinateReferenceSystem.WGS84)),
                result(3, Coordinate(40.5, 117.0, crs = CoordinateReferenceSystem.WGS84)),
            ),
        )

        assertTrue(projection.originUsable)
        assertTrue(projection.points.isEmpty())
        assertEquals(3, projection.skippedCount)
        assertTrue(
            projection.accessibilitySummary(DataRightsMode.LIVE_DISPLAY_ONLY)
                .contains("列表仍可使用"),
        )
    }

    @Test
    fun overlappingRestaurantsReceiveDistinctDeterministicMarkerPositions() {
        val sameCoordinate = Coordinate(39.901, 116.4, crs = CoordinateReferenceSystem.WGS84)
        val projection = NearbyOrientationProjector.project(
            context(CoordinateReferenceSystem.WGS84),
            listOf(
                result(1, sameCoordinate, name = "同名餐厅"),
                result(2, sameCoordinate, name = "同名餐厅"),
                result(3, sameCoordinate, name = "同名餐厅"),
            ),
        )

        assertEquals(3, projection.points.size)
        assertEquals(
            3,
            projection.points.map { it.xFraction to it.yFraction }.distinct().size,
        )
        assertTrue(projection.points.count(NearbyOrientationPoint::collisionOffsetApplied) >= 2)
        assertEquals(listOf(1, 2, 3), projection.points.map(NearbyOrientationPoint::rank))
    }

    @Test
    fun projectionAndAccessibilityNeverContainTokenCrsOrRawCoordinates() {
        val token = "T".repeat(43)
        val latitude = 39.901234
        val longitude = 116.401234
        val projection = NearbyOrientationProjector.project(
            context(CoordinateReferenceSystem.WGS84),
            listOf(
                result(
                    rank = 1,
                    coordinate = Coordinate(
                        latitude,
                        longitude,
                        crs = CoordinateReferenceSystem.WGS84,
                    ),
                    name = "餐厅 $token，坐标 $latitude,$longitude",
                    resultToken = token,
                ),
            ),
        )
        val outboundText = projection.toString() +
            projection.accessibilitySummary(DataRightsMode.LICENSED_ENRICHMENT) +
            projection.points.joinToString {
                it.accessibilityDescription(DataRightsMode.LICENSED_ENRICHMENT)
            }

        assertFalse(outboundText.contains(token))
        assertFalse(outboundText.contains(latitude.toString()))
        assertFalse(outboundText.contains(longitude.toString()))
        assertFalse(outboundText.contains("WGS84"))
        assertFalse(outboundText.contains("resultToken"))
        assertTrue(outboundText.contains("第 1 名"))
    }

    @Test
    fun liveDisplayAccessibilityDescribesProviderOrderWithoutRankingClaims() {
        val projection = NearbyOrientationProjector.project(
            context(CoordinateReferenceSystem.WGS84),
            listOf(
                result(1, Coordinate(39.901, 116.4, crs = CoordinateReferenceSystem.WGS84)),
                result(2, Coordinate(39.902, 116.4, crs = CoordinateReferenceSystem.WGS84)),
            ),
        )

        val summary = projection.accessibilitySummary(DataRightsMode.LIVE_DISPLAY_ONLY)

        assertTrue(summary.contains("数据源顺序第 1 个，首个候选"))
        assertTrue(summary.contains("数据源顺序第 2 个，其他候选"))
        assertFalse(summary.contains("主推荐"))
        assertFalse(summary.contains("备选"))
        assertFalse(summary.contains("第 1 名"))
    }

    @Test
    fun invalidOriginFailsClosedWithoutExposingCoordinates() {
        val projection = NearbyOrientationProjector.project(
            context(
                crs = CoordinateReferenceSystem.WGS84,
                coordinate = Coordinate(95.0, 116.4, crs = CoordinateReferenceSystem.WGS84),
            ),
            listOf(result(1, Coordinate(39.9, 116.4, crs = CoordinateReferenceSystem.WGS84))),
        )

        assertFalse(projection.originUsable)
        assertTrue(projection.points.isEmpty())
        assertEquals(1, projection.skippedCount)
        val summary = projection.accessibilitySummary(DataRightsMode.LIVE_DISPLAY_ONLY)
        assertTrue(summary.contains("起点信息异常"))
        assertFalse(summary.contains("95.0"))
    }

    private fun context(
        crs: CoordinateReferenceSystem,
        coordinate: Coordinate = Coordinate(39.9, 116.4, crs = crs),
    ) = RecommendationContext(
        location = coordinate,
        mealPeriod = MealPeriod.LUNCH,
        decisionMode = DecisionMode.QUICK,
        travelMode = TravelMode.WALK,
        explorationMode = ExplorationMode.BALANCED,
        radiusMeters = 1_500,
    )

    private fun result(
        rank: Int,
        coordinate: Coordinate,
        name: String = "测试餐厅 $rank",
        resultToken: String = tokenFor(rank),
    ) = RecommendationResult(
        provider = "AMAP",
        resultToken = resultToken,
        dataMode = RecommendationDataMode.LIVE,
        actions = RecommendationActions(true, true, true, true),
        name = name,
        address = "测试地址",
        rank = rank,
        fitScore = null,
        sourceRating = 4.0,
        averageCostYuan = 25.0,
        distanceMeters = 100.0,
        estimatedTravelMinutes = 5.0,
        estimatedMealMinutes = 30.0,
        openStatus = OpenStatus.OPEN,
        tags = listOf("中餐"),
        imageUrl = null,
        phone = null,
        location = coordinate,
        reasons = listOf(RecommendationReason(ReasonCode.DISTANCE_FIT, "距离合适")),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "授权数据源",
    )

    private companion object {
        fun tokenFor(rank: Int): String = rank.toString().repeat(43)
    }
}
