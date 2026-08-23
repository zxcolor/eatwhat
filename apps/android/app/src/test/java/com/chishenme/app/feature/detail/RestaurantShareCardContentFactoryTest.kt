package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.ReasonCode
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.RecommendationResult
import org.junit.Assert.assertNull
import org.junit.Test

class RestaurantShareCardContentFactoryTest {
    @Test
    fun android1_0GateRejectsCompleteContentBeforeVisibleFactsAreBuilt() {
        val result = result(
            reasons = listOf(
                RecommendationReason(ReasonCode.DISTANCE_FIT, "步行距离符合本次范围"),
                RecommendationReason(ReasonCode.BUDGET_FIT, "在本次预算范围内"),
                RecommendationReason(ReasonCode.TIME_FIT, "参考价格 35 元，距离 420 米"),
                RecommendationReason(ReasonCode.QUALITY_SIGNAL, "第四条不应出现在卡片"),
            ),
        )

        assertNull(RestaurantShareCardContentFactory.create(result))
    }

    @Test
    fun android1_0GateRejectsContentContainingSensitiveSourceFacts() {
        val token = "SECRET_RESULT_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        val phone = "+86 10 9876 5432"
        val otherToken = "Z".repeat(43)
        val result = result(
            provider = "INTERNAL_PROVIDER_CODE_93",
            resultToken = token,
            phone = phone,
            address = "测试地址 $token · 31.234567 · $phone",
            location = Coordinate(
                latitude = 31.234567,
                longitude = 121.987654,
                crs = CoordinateReferenceSystem.GCJ02,
            ),
            // Even if a visible server string accidentally repeats a known
            // secret, the outbound allow-list redacts that exact value.
            reasons = listOf(
                RecommendationReason(
                    ReasonCode.TIME_FIT,
                    "令牌 $otherToken requestId=123e4567-e89b-12d3-a456-426614174000",
                ),
                RecommendationReason(
                    ReasonCode.DISTANCE_FIT,
                    "lat=31.23，经度 121.987654，其他疑似坐标 88.123456",
                ),
                RecommendationReason(ReasonCode.MEAL_FIT, "电话 138-0013-8000"),
            ),
            sourceAttribution = "异常来源 support@example.com",
        )

        assertNull(RestaurantShareCardContentFactory.create(result))
    }

    @Test
    fun android1_0GateRejectsBothLiveAndAssistedDemoContent() {
        val normal = RestaurantShareCardContentFactory.create(
            result(aiAssisted = false, dataMode = RecommendationDataMode.LIVE),
        )
        val assistedDemo = RestaurantShareCardContentFactory.create(
            result(aiAssisted = true, dataMode = RecommendationDataMode.DEMO),
        )

        assertNull(normal)
        assertNull(assistedDemo)
    }

    @Test
    fun serverShareCapabilityFailsClosedBeforeCardGeneration() {
        val denied = result(actions = RecommendationActions(true, true, true, false))

        assertNull(RestaurantShareCardContentFactory.create(denied))
    }

    @Test
    fun android1_0GateRejectsContentWhenServerReasonsAreMissing() {
        assertNull(RestaurantShareCardContentFactory.create(result(reasons = emptyList())))
    }

    private fun result(
        provider: String = "AMAP",
        resultToken: String = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        dataMode: RecommendationDataMode = RecommendationDataMode.LIVE,
        actions: RecommendationActions = RecommendationActions(true, true, true, true),
        address: String = "北京市测试路 1 号",
        phone: String? = "+86 10 1234 5678",
        location: Coordinate = Coordinate(
            latitude = 39.9,
            longitude = 116.4,
            crs = CoordinateReferenceSystem.GCJ02,
        ),
        reasons: List<RecommendationReason> = listOf(
            RecommendationReason(ReasonCode.TIME_FIT, "适合本次用餐时间"),
            RecommendationReason(ReasonCode.BUDGET_FIT, "符合本次预算"),
        ),
        aiAssisted: Boolean = false,
        sourceAttribution: String = "授权餐厅数据",
    ) = RecommendationResult(
        provider = provider,
        resultToken = resultToken,
        dataMode = dataMode,
        actions = actions,
        name = "测试餐厅",
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
        imageUrl = "https://example.invalid/provider-image.jpg",
        phone = phone,
        location = location,
        reasons = reasons,
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = aiAssisted,
        sourceAttribution = sourceAttribution,
    )
}
