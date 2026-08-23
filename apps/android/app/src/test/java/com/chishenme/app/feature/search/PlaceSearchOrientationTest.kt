package com.chishenme.app.feature.search

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.data.remote.RecommendationActions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PlaceSearchOrientationTest {
    @Test
    fun `projection never includes token or precise coordinates in accessibility text`() {
        val token = "T".repeat(43)
        val projection = PlaceSearchOrientationProjector.project(
            origin = PlaceSearchCoordinate(39.99, 116.31, CoordinateReferenceSystem.GCJ02),
            radiusMeters = 1_500,
            results = listOf(result(token = token)),
        )

        val description = projection.accessibilityDescription()
        assertFalse(description.contains(token))
        assertFalse(description.contains("39.99"))
        assertFalse(description.contains("116.31"))
        assertEquals(1, projection.points.size)
    }

    @Test
    fun `WGS84 origin is aligned to GCJ02 results for presentation`() {
        val projection = PlaceSearchOrientationProjector.project(
            origin = PlaceSearchCoordinate(39.99, 116.31, CoordinateReferenceSystem.WGS84),
            radiusMeters = 1_500,
            results = listOf(result()),
        )

        assertEquals(1, projection.points.size)
        assertEquals(0, projection.skippedCount)
    }

    private fun result(token: String = "A".repeat(43)) = PlaceSearchResult(
        resultToken = token,
        rank = 3,
        name = "学院路面馆",
        address = null,
        location = PlaceSearchCoordinate(39.991, 116.311, CoordinateReferenceSystem.GCJ02),
        distanceMeters = 150,
        sourceLabel = "授权餐厅数据",
        sourceRating = null,
        averageCostYuan = null,
        openStatus = OpenStatus.UNKNOWN,
        tags = emptyList(),
        dataMode = "LIVE",
        actions = RecommendationActions(false, false, false, false),
    )
}
