package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.feature.session.ResultSessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RestaurantActionAvailabilityTest {
    @Test
    fun `unconfirmed and expired sessions disable every action before source facts`() {
        val cases = listOf(
            ResultSessionState.CONFIG_UNCONFIRMED to
                RestaurantActionUnavailableReason.CONFIG_UNCONFIRMED,
            ResultSessionState.EXPIRED to RestaurantActionUnavailableReason.SESSION_EXPIRED,
        )

        cases.forEach { (sessionState, expectedReason) ->
            val availability = RestaurantActionAvailabilityPolicy.evaluate(result(), sessionState)
            listOf(
                availability.navigate,
                availability.call,
                availability.copyAddress,
            ).forEach { status ->
                assertFalse(status.enabled)
                assertEquals(expectedReason, status.unavailableReason)
            }
            assertFalse(availability.share.enabled)
            assertEquals(
                RestaurantActionUnavailableReason.SOURCE_NOT_ENABLED,
                availability.share.unavailableReason,
            )
            assertEquals(1, availability.pageMessages().size)
        }
    }

    @Test
    fun `each source capability independently fails closed`() {
        val allAllowed = result()
        val cases = listOf(
            allAllowed.copy(actions = allAllowed.actions.copy(navigate = false)) to
                { availability: RestaurantActionAvailability -> availability.navigate },
            allAllowed.copy(actions = allAllowed.actions.copy(call = false)) to
                { availability: RestaurantActionAvailability -> availability.call },
            allAllowed.copy(actions = allAllowed.actions.copy(copyAddress = false)) to
                { availability: RestaurantActionAvailability -> availability.copyAddress },
        )

        cases.forEach { (candidate, selectStatus) ->
            val status = selectStatus(RestaurantActionAvailabilityPolicy.evaluate(candidate))
            assertFalse(status.enabled)
            assertEquals(RestaurantActionUnavailableReason.SOURCE_NOT_ENABLED, status.unavailableReason)
        }
    }

    @Test
    fun `android 1_0 disables share even when the server enables it`() {
        val availability = RestaurantActionAvailabilityPolicy.evaluate(
            result(actions = RecommendationActions(true, true, true, true)),
        )

        assertFalse(availability.share.enabled)
        assertEquals(
            RestaurantActionUnavailableReason.SOURCE_NOT_ENABLED,
            availability.share.unavailableReason,
        )
        assertTrue(availability.pageMessages().isEmpty())
    }

    @Test
    fun `source refusal is summarized once without provider or token`() {
        val result = result(
            provider = "AUTHORIZED_VENDOR",
            resultToken = "SECRET_RESULT_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            actions = RecommendationActions(
                navigate = false,
                call = false,
                copyAddress = false,
                share = false,
            ),
        )

        val availability = RestaurantActionAvailabilityPolicy.evaluate(result)

        assertEquals(listOf("当前数据来源尚未开放部分操作。"), availability.pageMessages())
        val visibleText = availability.pageMessages().joinToString() +
            listOf(
                availability.navigate.disabledStateDescription("地图查询"),
                availability.call.disabledStateDescription("联系商户"),
                availability.copyAddress.disabledStateDescription("复制地址"),
            ).joinToString()
        assertFalse(visibleText.contains(result.provider))
        assertFalse(visibleText.contains(result.resultToken))
    }

    @Test
    fun `missing local facts disable only actions that need those facts`() {
        val availability = RestaurantActionAvailabilityPolicy.evaluate(
            result(
                name = " \n ",
                address = " \t ",
                phone = "暂无电话",
            ),
        )

        assertFalse(availability.navigate.enabled)
        assertEquals(
            RestaurantActionUnavailableReason.MISSING_NAVIGATION_QUERY,
            availability.navigate.unavailableReason,
        )
        assertFalse(availability.call.enabled)
        assertEquals(RestaurantActionUnavailableReason.MISSING_PHONE, availability.call.unavailableReason)
        assertFalse(availability.copyAddress.enabled)
        assertEquals(RestaurantActionUnavailableReason.MISSING_ADDRESS, availability.copyAddress.unavailableReason)
        assertFalse(availability.share.enabled)
        assertEquals(
            RestaurantActionUnavailableReason.SOURCE_NOT_ENABLED,
            availability.share.unavailableReason,
        )
        assertEquals(
            listOf(
                "暂无可用于地图查询的可靠名称或地址。",
                "暂无可靠电话，暂时无法联系商户。",
                "暂无可靠地址，暂时无法复制。",
            ),
            availability.pageMessages(),
        )
    }

    @Test
    fun `demo result with no phone clearly disables contact`() {
        val availability = RestaurantActionAvailabilityPolicy.evaluate(
            result(dataMode = RecommendationDataMode.DEMO, phone = null),
        )

        assertFalse(availability.call.enabled)
        assertEquals(RestaurantActionUnavailableReason.MISSING_PHONE, availability.call.unavailableReason)
        assertEquals("联系商户不可用：暂无可靠电话", availability.call.disabledStateDescription("联系商户"))
    }

    @Test
    fun `complete authorized fields enable only Android 1_0 actions`() {
        val availability = RestaurantActionAvailabilityPolicy.evaluate(result())

        assertTrue(availability.navigate.enabled)
        assertTrue(availability.call.enabled)
        assertTrue(availability.copyAddress.enabled)
        assertFalse(availability.share.enabled)
        assertEquals(
            RestaurantActionUnavailableReason.SOURCE_NOT_ENABLED,
            availability.share.unavailableReason,
        )
        assertTrue(availability.pageMessages().isEmpty())
    }

    @Test
    fun `unknown provider and data mode do not change policy`() {
        val live = RestaurantActionAvailabilityPolicy.evaluate(
            result(provider = "AUTHORIZED_VENDOR", dataMode = RecommendationDataMode.LIVE),
        )
        val demo = RestaurantActionAvailabilityPolicy.evaluate(
            result(provider = "FUTURE_SOURCE_9", dataMode = RecommendationDataMode.DEMO),
        )

        assertEquals(live, demo)
    }

    private fun result(
        provider: String = "AMAP",
        resultToken: String = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        dataMode: RecommendationDataMode = RecommendationDataMode.LIVE,
        actions: RecommendationActions = RecommendationActions(
            navigate = true,
            call = true,
            copyAddress = true,
            share = true,
        ),
        name: String = "测试餐厅",
        address: String = "北京市测试路 1 号",
        phone: String? = "+86 10 1234 5678",
    ) = RecommendationResult(
        provider = provider,
        resultToken = resultToken,
        dataMode = dataMode,
        actions = actions,
        name = name,
        address = address,
        rank = 1,
        fitScore = null,
        sourceRating = 4.5,
        averageCostYuan = 35.0,
        distanceMeters = 420.0,
        estimatedTravelMinutes = 8.0,
        estimatedMealMinutes = 35.0,
        openStatus = OpenStatus.OPEN,
        tags = listOf("中餐"),
        imageUrl = null,
        phone = phone,
        location = Coordinate(
            latitude = 39.9,
            longitude = 116.4,
            crs = CoordinateReferenceSystem.GCJ02,
        ),
        reasons = emptyList(),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "授权数据源",
    )
}
