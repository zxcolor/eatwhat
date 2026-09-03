package com.chishenme.app.feature.results

import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationResult
import java.util.Locale

internal data class RecommendationResultsFilterState(
    val openNowOnly: Boolean = false,
    val knownPriceWithinBudgetOnly: Boolean = false,
    val cuisineTagQuery: String = "",
) {
    val isActive: Boolean
        get() = openNowOnly || knownPriceWithinBudgetOnly || cuisineTagQuery.isNotBlank()
}

/**
 * Local, session-only filtering for the at-most-three results already returned
 * by the server. It never changes ranking or turns unknown facts into negative
 * facts.
 */
internal object RecommendationResultsFilter {
    fun apply(
        results: List<RecommendationResult>,
        budgetMaxYuan: Int?,
        filter: RecommendationResultsFilterState,
    ): List<RecommendationResult> {
        val cuisineQuery = normalizeTag(filter.cuisineTagQuery)
        return results.take(MAX_RESULTS).filter { result ->
            val matchesOpen = !filter.openNowOnly || result.openStatus == OpenStatus.OPEN
            val matchesPrice = !filter.knownPriceWithinBudgetOnly || result.averageCostYuan?.let { cost ->
                cost.isFinite() && cost >= 0.0 &&
                    (budgetMaxYuan == null || cost <= budgetMaxYuan.toDouble())
            } == true
            val matchesCuisine = cuisineQuery.isEmpty() || result.tags.any { tag ->
                normalizeTag(tag).contains(cuisineQuery)
            }
            matchesOpen && matchesPrice && matchesCuisine
        }
    }

    fun countSummary(
        visibleCount: Int,
        totalCount: Int,
        filter: RecommendationResultsFilterState,
        dataRightsMode: DataRightsMode,
    ): String = if (filter.isActive) {
        "本地筛选显示 " + visibleCount + " / " + totalCount.coerceAtMost(MAX_RESULTS) + " 条"
    } else if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
        "本次共 " + totalCount.coerceAtMost(MAX_RESULTS) + " 个候选"
    } else {
        "本次共 " + totalCount.coerceAtMost(MAX_RESULTS) + " 条推荐"
    }

    private fun normalizeTag(value: String): String = value
        .trim()
        .lowercase(Locale.CHINA)
        .replace(TAG_WHITESPACE, "")

    private val TAG_WHITESPACE = Regex("\\s+")
    private const val MAX_RESULTS = 3
}
