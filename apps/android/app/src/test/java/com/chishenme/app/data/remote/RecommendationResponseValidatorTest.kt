package com.chishenme.app.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecommendationResponseValidatorTest {
    private val context = RecommendationContext(
        location = Coordinate(
            latitude = 39.9928,
            longitude = 116.3109,
            crs = CoordinateReferenceSystem.WGS84,
        ),
        mealPeriod = MealPeriod.LUNCH,
        budgetMaxYuan = 50,
        availableMinutes = 30,
        radiusMeters = 1_500,
        excludedCuisines = listOf("火锅"),
    )

    @Test
    fun `rejects an explicitly closed result but accepts unknown open status`() {
        assertFalse(isValid(result().copy(openStatus = OpenStatus.CLOSED)))
        assertTrue(isValid(result().copy(openStatus = OpenStatus.UNKNOWN)))
    }

    @Test
    fun `rejects distance beyond requested radius and accepts the boundary`() {
        assertFalse(isValid(result().copy(distanceMeters = 1_500.01)))
        assertTrue(isValid(result().copy(distanceMeters = 1_500.0)))
    }

    @Test
    fun `rejects known cost beyond budget without rejecting an unknown cost`() {
        assertFalse(isValid(result().copy(averageCostYuan = 50.01)))
        assertTrue(isValid(result().copy(averageCostYuan = 50.0)))
        assertTrue(isValid(result().copy(averageCostYuan = null)))
    }

    @Test
    fun `rejects an explicitly excluded cuisine but not missing tag information`() {
        assertFalse(isValid(result().copy(tags = listOf("重庆火锅", "聚餐"))))
        assertTrue(isValid(result().copy(tags = emptyList())))
    }

    @Test
    fun `does not turn soft time guidance or unknown facts into hard rejection`() {
        val uncertain = result().copy(
            sourceRating = null,
            averageCostYuan = null,
            estimatedTravelMinutes = 45.0,
            estimatedMealMinutes = 60.0,
            openStatus = OpenStatus.UNKNOWN,
            tags = emptyList(),
            confidence = Confidence.LOW,
            warnings = listOf("营业时间待确认", "预计时间可能超出预算"),
        )

        assertTrue(isValid(uncertain))
    }

    @Test
    fun `does not apply a budget ceiling when the request has no hard budget`() {
        val noBudget = context.copy(budgetMaxYuan = null)
        val expensive = result().copy(averageCostYuan = 8_888.0)

        assertTrue(RecommendationResponseValidator.isValid(response(expensive), noBudget))
    }

    @Test
    fun `accepts unknown well formed provider code without inferring its coordinate system`() {
        assertTrue(
            isValid(
                result().copy(
                    provider = "LOCAL_PARTNER_7",
                    location = result().location.copy(crs = CoordinateReferenceSystem.GCJ02),
                ),
            ),
        )
        assertTrue(
            isValid(
                result().copy(
                    provider = "LOCAL_PARTNER_7",
                    location = result().location.copy(crs = CoordinateReferenceSystem.WGS84),
                ),
            ),
        )
    }

    @Test
    fun `accepts exactly 43 base64url characters as an opaque result token`() {
        assertTrue(isValid(result().copy(resultToken = "abcdefghijklmnopqrstuvwxyzABCDEFGH0123456_-")))
    }

    @Test
    fun `rejects result tokens with invalid length or characters`() {
        listOf(
            "A".repeat(42),
            "A".repeat(44),
            "A".repeat(42) + "+",
            "A".repeat(42) + "/",
            "A".repeat(42) + "=",
            "A".repeat(42) + " ",
        ).forEach { token ->
            assertFalse(isValid(result().copy(resultToken = token)))
        }
    }

    @Test
    fun `rejects duplicate opaque tokens within one response`() {
        val first = result()
        val second = first.copy(rank = 2, name = "另一家餐厅", address = "北京市测试路 2 号")

        assertFalse(
            RecommendationResponseValidator.isValid(
                response(first).copy(results = listOf(first, second)),
                context,
            ),
        )
    }

    @Test
    fun `rejects malformed provider codes but permits disabled capabilities`() {
        listOf("A", "amap", "AMAP-DIRECT", "A".repeat(33)).forEach { provider ->
            assertFalse(isValid(result().copy(provider = provider)))
        }
        assertTrue(
            isValid(
                result().copy(
                    provider = "PARTNER_2",
                    actions = RecommendationActions(false, false, false, false),
                ),
            ),
        )
    }

    private fun isValid(result: RecommendationResult): Boolean =
        RecommendationResponseValidator.isValid(response(result), context)

    private fun response(result: RecommendationResult) = RecommendationResponse(
        requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
        generatedAt = "2026-08-20T04:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback",
        aiFallbackUsed = true,
        results = listOf(result),
        notice = null,
    )

    private fun result() = RecommendationResult(
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
        averageCostYuan = 35.0,
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
    )
}
