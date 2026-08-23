package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationResult
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RestaurantActionFactoryTest {
    @Test
    fun `navigation geocodes visible name and address instead of exporting GCJ02 coordinates`() {
        val result = result(
            name = "  东来顺 王府井店 ",
            address = "北京市 东城区\n王府井大街 198 号",
            location = Coordinate(
                latitude = 39.914_987,
                longitude = 116.412_345,
                crs = CoordinateReferenceSystem.GCJ02,
            ),
        )

        val action = RestaurantActionFactory.navigation(result)!!
        val encodedQuery = action.uri.substringAfter("?q=")

        assertTrue(action.uri.startsWith("geo:0,0?q="))
        assertEquals(
            "东来顺 王府井店 北京市 东城区 王府井大街 198 号",
            URLDecoder.decode(encodedQuery, StandardCharsets.UTF_8),
        )
        assertFalse(action.uri.contains("39.914987"))
        assertFalse(action.uri.contains("116.412345"))
        assertFalse(action.uri.contains(result.resultToken))
    }

    @Test
    fun `dial is absent for missing phone and percent encodes the provided value`() {
        assertNull(RestaurantActionFactory.dial(result(phone = null)))
        assertNull(RestaurantActionFactory.dial(result(phone = " \n\t ")))
        assertNull(RestaurantActionFactory.dial(result(phone = "暂无电话")))

        val action = RestaurantActionFactory.dial(result(phone = " +86 (010) 1234-5678 "))

        assertEquals(
            "+86 (010) 1234-5678",
            URLDecoder.decode(action!!.uri.removePrefix("tel:"), StandardCharsets.UTF_8),
        )
        assertFalse(action.uri.removePrefix("tel:").contains(" "))
    }

    @Test
    fun `android 1_0 blocks share content even for a complete enabled result`() {
        val result = result(
            provider = "LOCAL_PARTNER_7",
            dataMode = RecommendationDataMode.DEMO,
            resultToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            aiAssisted = true,
            sourceAttribution = "演示餐厅样本",
            location = Coordinate(
                latitude = 31.234_567,
                longitude = 121.987_654,
                crs = CoordinateReferenceSystem.GCJ02,
            ),
        )

        assertNull(RestaurantShareCardContentFactory.create(result))
    }

    @Test
    fun `live data mode does not inherit demo semantics from provider code`() {
        val result = result(
            provider = "DEMO",
            dataMode = RecommendationDataMode.LIVE,
            aiAssisted = false,
            address = " 北京市海淀区测试路 1 号 ",
        )

        val share = RestaurantShareCardContentFactory.create(result)
        val clipboard = RestaurantActionFactory.clipboard(result)!!

        assertNull(share)
        assertEquals("餐厅地址", clipboard.label)
        assertEquals("北京市海淀区测试路 1 号", clipboard.text)
    }

    @Test
    fun `each server capability independently gates outbound action construction`() {
        val allowed = result(
            actions = RecommendationActions(
                navigate = true,
                call = true,
                copyAddress = true,
                share = true,
            ),
        )

        assertNotNull(RestaurantActionFactory.navigation(allowed))
        assertNotNull(RestaurantActionFactory.dial(allowed))
        assertNotNull(RestaurantActionFactory.clipboard(allowed))
        assertNull(RestaurantShareCardContentFactory.create(allowed))

        assertNull(
            RestaurantActionFactory.navigation(
                allowed.copy(actions = allowed.actions.copy(navigate = false)),
            ),
        )
        assertNull(
            RestaurantActionFactory.dial(
                allowed.copy(actions = allowed.actions.copy(call = false)),
            ),
        )
        assertNull(
            RestaurantActionFactory.clipboard(
                allowed.copy(actions = allowed.actions.copy(copyAddress = false)),
            ),
        )
        assertNull(
            RestaurantShareCardContentFactory.create(
                allowed.copy(actions = allowed.actions.copy(share = false)),
            ),
        )
    }

    @Test
    fun `opaque result token never enters any outbound action`() {
        val token = "SECRET_RESULT_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        val result = result(resultToken = token)

        assertFalse(RestaurantActionFactory.navigation(result)!!.uri.contains(token))
        assertFalse(RestaurantActionFactory.dial(result)!!.uri.contains(token))
        assertFalse(RestaurantActionFactory.clipboard(result)!!.text.contains(token))
        assertNull(RestaurantShareCardContentFactory.create(result))
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
        location: Coordinate = Coordinate(
            latitude = 39.9,
            longitude = 116.4,
            crs = CoordinateReferenceSystem.GCJ02,
        ),
        phone: String? = "+86 10 1234 5678",
        aiAssisted: Boolean = false,
        sourceAttribution: String = "高德开放平台",
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
        location = location,
        reasons = emptyList(),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = aiAssisted,
        sourceAttribution = sourceAttribution,
    )
}
