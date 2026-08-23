package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.data.remote.RecommendationActions
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaceSearchRestaurantActionTest {
    @Test
    fun `search details use provider neutral actions without recommendation conversion`() {
        val token = "S".repeat(43)
        val display = result(token = token).toRestaurantDisplayModel()

        val navigation = RestaurantActionFactory.navigation(display)
        val clipboard = RestaurantActionFactory.clipboard(display)
        val shareText = RestaurantActionFactory.shareText(display)

        assertTrue(navigation?.uri?.startsWith("geo:0,0?q=") == true)
        assertTrue(clipboard?.text == "海淀区学院路 25 号")
        assertNull(shareText)
        assertFalse(navigation?.uri?.contains(token) == true)
        assertNull(RestaurantActionFactory.dial(display))
    }

    @Test
    fun `server disabled actions remain disabled regardless of data mode`() {
        val display = result(
            dataMode = "FUTURE_SAFE",
            actions = RecommendationActions(false, false, false, false),
        ).toRestaurantDisplayModel()

        val availability = RestaurantActionAvailabilityPolicy.evaluate(display)

        assertFalse(availability.navigate.enabled)
        assertFalse(availability.call.enabled)
        assertFalse(availability.copyAddress.enabled)
        assertFalse(availability.share.enabled)
    }

    private fun result(
        token: String = "A".repeat(43),
        dataMode: String = "LIVE",
        actions: RecommendationActions = RecommendationActions(true, true, true, true),
    ) = PlaceSearchResult(
        resultToken = token,
        rank = 1,
        name = "学院路面馆",
        address = "海淀区学院路 25 号",
        location = PlaceSearchCoordinate(39.993, 116.311, CoordinateReferenceSystem.GCJ02),
        distanceMeters = 300,
        sourceLabel = "授权餐厅数据",
        sourceRating = 4.5,
        averageCostYuan = 25.0,
        openStatus = OpenStatus.OPEN,
        tags = listOf("面食"),
        dataMode = dataMode,
        actions = actions,
    )
}
