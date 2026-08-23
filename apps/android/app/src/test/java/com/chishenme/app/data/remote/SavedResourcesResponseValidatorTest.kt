package com.chishenme.app.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SavedResourcesResponseValidatorTest {
    @Test
    fun `available projection accepts only safe live presentation`() {
        assertTrue(SavedResourcesResponseValidator.validPresentation(available()))
        assertFalse(
            SavedResourcesResponseValidator.validPresentation(
                available().copy(dataMode = RecommendationDataMode.DEMO),
            ),
        )
    }

    @Test
    fun `rights revoked tombstone contains no stale restaurant presentation`() {
        val tombstone = PersistedPlacePresentation(
            presentationStatus = PersistedPresentationStatus.RIGHTS_REVOKED,
            retryable = false,
        )
        assertTrue(SavedResourcesResponseValidator.validPresentation(tombstone))
        assertFalse(
            SavedResourcesResponseValidator.validPresentation(
                tombstone.copy(name = "不应继续展示的店名"),
            ),
        )
    }

    @Test
    fun `presentation rejects embedded phone coordinate email and result token`() {
        listOf(
            "联系 138-0013-8000",
            "位置 39.9042, 116.4074",
            "联系 food@example.com",
            "异常 ${"T".repeat(43)} 文本",
        ).forEach { unsafe ->
            assertFalse(
                unsafe,
                SavedResourcesResponseValidator.validPresentation(available().copy(sourceLabel = unsafe)),
            )
        }
        assertTrue(SavedResourcesResponseValidator.validPresentation(available().copy(address = "海淀区学院路 25 号")))
    }

    @Test
    fun `history enforces exact ninety day expiry and hides no invalid tombstone`() {
        val valid = RecommendationHistoryPage(
            items = listOf(
                RecommendationHistoryItem(
                    historyId = "11111111-1111-4111-8111-111111111111",
                    action = RecommendationHistoryAction.DETAIL_VIEWED,
                    mealPeriod = MealPeriod.LUNCH,
                    occurredAt = "2026-08-21T00:00:00Z",
                    expiresAt = "2026-11-19T00:00:00Z",
                    presentation = PersistedPlacePresentation(
                        presentationStatus = PersistedPresentationStatus.RIGHTS_REVOKED,
                        retryable = false,
                    ),
                ),
            ),
            nextCursor = null,
            retentionDays = 90,
        )
        assertTrue(SavedResourcesResponseValidator.validHistoryPage(valid))
        assertFalse(
            SavedResourcesResponseValidator.validHistoryPage(
                valid.copy(items = valid.items.map { it.copy(expiresAt = "2026-11-18T00:00:00Z") }),
            ),
        )
    }

    private fun available() = PersistedPlacePresentation(
        presentationStatus = PersistedPresentationStatus.AVAILABLE,
        name = "学院路面馆",
        address = "海淀区学院路 25 号",
        sourceLabel = "经授权餐厅数据",
        dataMode = RecommendationDataMode.LIVE,
        openStatus = OpenStatus.OPEN,
        averageCostYuan = 25.0,
        tags = listOf("面食", "午餐"),
        resolvedAt = "2026-08-21T00:00:00Z",
    )
}
