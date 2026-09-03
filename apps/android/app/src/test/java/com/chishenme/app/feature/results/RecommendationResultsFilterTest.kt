package com.chishenme.app.feature.results

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.ReasonCode
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.RecommendationResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecommendationResultsFilterTest {
    private val results = listOf(
        result(1, OpenStatus.OPEN, 20.0, listOf("经典 川菜")),
        result(2, OpenStatus.UNKNOWN, null, listOf("面食", "家常菜")),
        result(3, OpenStatus.CLOSED, 40.0, listOf("咖啡")),
    )

    @Test
    fun unknownStatusRemainsVisibleUntilOpenOnlyFilterIsExplicitlyEnabled() {
        val unfiltered = RecommendationResultsFilter.apply(
            results,
            budgetMaxYuan = 25,
            filter = RecommendationResultsFilterState(),
        )
        val openOnly = RecommendationResultsFilter.apply(
            results,
            budgetMaxYuan = 25,
            filter = RecommendationResultsFilterState(openNowOnly = true),
        )

        assertEquals(listOf(1, 2, 3), unfiltered.map(RecommendationResult::rank))
        assertEquals(listOf(1), openOnly.map(RecommendationResult::rank))
        assertTrue(unfiltered.single { it.rank == 2 }.openStatus == OpenStatus.UNKNOWN)
    }

    @Test
    fun unknownPriceIsNotOverBudgetButDoesNotSatisfyKnownPriceFilter() {
        val filtered = RecommendationResultsFilter.apply(
            results,
            budgetMaxYuan = 25,
            filter = RecommendationResultsFilterState(knownPriceWithinBudgetOnly = true),
        )
        val unlimitedKnownPrice = RecommendationResultsFilter.apply(
            results,
            budgetMaxYuan = null,
            filter = RecommendationResultsFilterState(knownPriceWithinBudgetOnly = true),
        )

        assertEquals(listOf(1), filtered.map(RecommendationResult::rank))
        assertEquals(listOf(1, 3), unlimitedKnownPrice.map(RecommendationResult::rank))
        assertTrue(results.single { it.rank == 2 }.averageCostYuan == null)
    }

    @Test
    fun cuisineTagTextIsWhitespaceInsensitiveAndCombinesWithOtherFilters() {
        val cuisineOnly = RecommendationResultsFilter.apply(
            results,
            budgetMaxYuan = 25,
            filter = RecommendationResultsFilterState(cuisineTagQuery = "川 菜"),
        )
        val combined = RecommendationResultsFilter.apply(
            results,
            budgetMaxYuan = 25,
            filter = RecommendationResultsFilterState(
                openNowOnly = true,
                knownPriceWithinBudgetOnly = true,
                cuisineTagQuery = "经典川菜",
            ),
        )

        assertEquals(listOf(1), cuisineOnly.map(RecommendationResult::rank))
        assertEquals(listOf(1), combined.map(RecommendationResult::rank))
    }

    @Test
    fun countSummaryContainsNoResultToken() {
        val token = results.first().resultToken
        val summary = RecommendationResultsFilter.countSummary(
            visibleCount = 1,
            totalCount = results.size,
            filter = RecommendationResultsFilterState(openNowOnly = true),
            dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        )

        assertEquals("本地筛选显示 1 / 3 条", summary)
        assertFalse(summary.contains(token))
        assertFalse(summary.contains("resultToken"))
    }

    @Test
    fun countSummaryUsesCandidateLanguageForLiveDisplayOnly() {
        val live = RecommendationResultsFilter.countSummary(
            visibleCount = 3,
            totalCount = 3,
            filter = RecommendationResultsFilterState(),
            dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        )
        val licensed = RecommendationResultsFilter.countSummary(
            visibleCount = 3,
            totalCount = 3,
            filter = RecommendationResultsFilterState(),
            dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT,
        )

        assertEquals("本次共 3 个候选", live)
        assertFalse(live.contains("推荐"))
        assertEquals("本次共 3 条推荐", licensed)
    }

    private fun result(
        rank: Int,
        status: OpenStatus,
        price: Double?,
        tags: List<String>,
    ) = RecommendationResult(
        provider = "AMAP",
        resultToken = rank.toString().repeat(43),
        dataMode = RecommendationDataMode.LIVE,
        actions = RecommendationActions(true, true, true, true),
        name = "测试餐厅 $rank",
        address = "测试地址",
        rank = rank,
        fitScore = null,
        sourceRating = 4.0,
        averageCostYuan = price,
        distanceMeters = 100.0,
        estimatedTravelMinutes = 5.0,
        estimatedMealMinutes = 30.0,
        openStatus = status,
        tags = tags,
        imageUrl = null,
        phone = null,
        location = Coordinate(
            39.9 + rank / 10_000.0,
            116.4,
            crs = CoordinateReferenceSystem.WGS84,
        ),
        reasons = listOf(RecommendationReason(ReasonCode.DISTANCE_FIT, "距离合适")),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "授权数据源",
    )
}
