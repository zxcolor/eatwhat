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
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RestaurantShareCardGeneratorTest {
    @Test
    fun rendererContractWritesOnlyTheSuppliedAllowListedContent() {
        val expected = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        val output = ByteArrayOutputStream()
        val renderer = RestaurantShareCardPngRenderer { content, stream ->
            assertTrue(content.visibleText().contains("测试餐厅"))
            stream.write(expected)
            true
        }

        assertTrue(renderer.renderPng(content(), output))
        assertArrayEquals(expected, output.toByteArray())
    }

    @Test
    fun android1_0GateNeverCreatesAFileOrInvokesRendererWhenServerAllowsShare() {
        val root = Files.createTempDirectory("share-generator-gated").toFile()
        try {
            var invoked = false
            val generator = RestaurantShareCardGenerator(
                RestaurantShareCardPngRenderer { _, _ ->
                    invoked = true
                    true
                },
            )

            assertNull(generator.generate(root, result()))
            assertFalse(invoked)
            assertFalse(root.resolve(RestaurantShareCardStore.SHARE_DIRECTORY_NAME).exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun deniedActionNeverCreatesAFileOrInvokesRenderer() {
        val root = Files.createTempDirectory("share-generator-denied").toFile()
        try {
            var invoked = false
            val generator = RestaurantShareCardGenerator(
                RestaurantShareCardPngRenderer { _, _ ->
                    invoked = true
                    true
                },
            )

            val file = generator.generate(
                root,
                result(actions = RecommendationActions(true, true, true, false)),
            )

            assertNull(file)
            assertFalse(invoked)
            assertFalse(root.resolve(RestaurantShareCardStore.SHARE_DIRECTORY_NAME).exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun android1_0GateNeverReachesAFailingRenderer() {
        val root = Files.createTempDirectory("share-generator-failure-gated").toFile()
        try {
            var invoked = false
            val generator = RestaurantShareCardGenerator(
                RestaurantShareCardPngRenderer { _, output ->
                    invoked = true
                    output.write(byteArrayOf(1, 2, 3))
                    false
                },
            )

            assertNull(generator.generate(root, result()))
            assertFalse(invoked)
            assertFalse(root.resolve(RestaurantShareCardStore.SHARE_DIRECTORY_NAME).exists())
        } finally {
            root.deleteRecursively()
        }
    }

    private fun content() = RestaurantShareCardContent(
        restaurantName = "测试餐厅",
        address = "北京市测试路 1 号",
        facts = listOf("距离 约 420 米", "参考人均 约 35 元", "营业中"),
        reasons = listOf("适合本次用餐时间", "符合本次预算"),
        sourceAttribution = "数据来源：授权餐厅数据",
        aiNotice = null,
        dataNotice = "当前会话信息：距离、价格和营业状态以本次返回为准",
        safetyNotice = "营业、价格及过敏原信息可能变化，出发前请向商户确认。",
    )

    private fun result(
        actions: RecommendationActions = RecommendationActions(true, true, true, true),
    ) = RecommendationResult(
        provider = "AMAP",
        resultToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        dataMode = RecommendationDataMode.LIVE,
        actions = actions,
        name = "测试餐厅",
        address = "北京市测试路 1 号",
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
        phone = "+86 10 1234 5678",
        location = Coordinate(39.9, 116.4, crs = CoordinateReferenceSystem.GCJ02),
        reasons = listOf(
            RecommendationReason(ReasonCode.TIME_FIT, "适合本次用餐时间"),
            RecommendationReason(ReasonCode.BUDGET_FIT, "符合本次预算"),
        ),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "授权餐厅数据",
    )
}
