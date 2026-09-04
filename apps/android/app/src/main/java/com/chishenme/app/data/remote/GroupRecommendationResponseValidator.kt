package com.chishenme.app.data.remote

import java.time.Instant
import java.util.Locale
import java.util.UUID

object GroupRecommendationResponseValidator {
    fun isValid(
        response: GroupRecommendationResponse,
        request: GroupRecommendationRequest,
        expectedAggregation: GroupConstraintAggregation,
        expectedDataRightsMode: DataRightsMode,
        expectedRuleVersion: String,
    ): Boolean {
        if (runCatching { UUID.fromString(response.requestId) }.isFailure) return false
        if (runCatching { Instant.parse(response.generatedAt) }.isFailure) return false
        if (response.coverage != Coverage.NATIONWIDE) return false
        if (expectedRuleVersion.isBlank() || expectedRuleVersion.length > 80) return false
        if (response.ruleVersion != expectedRuleVersion) return false
        if (response.dataRightsMode != expectedDataRightsMode) return false
        if (response.notice != null && response.notice.length > 500) return false
        if (!aggregationMatches(response.aggregation, expectedAggregation, request.members.size)) {
            return false
        }
        if (response.results.size > 3) return false

        return response.results.withIndex().all { (index, result) ->
            result.rank == index + 1 &&
                resultIsValid(result, response.dataRightsMode, expectedAggregation)
        }
    }

    private fun aggregationMatches(
        actual: GroupConstraintAggregation,
        expected: GroupConstraintAggregation,
        requestMemberCount: Int,
    ): Boolean =
        actual.version == GROUP_AGGREGATION_VERSION &&
            expected.version == GROUP_AGGREGATION_VERSION &&
            actual.memberCount == requestMemberCount &&
            actual == expected

    private fun resultIsValid(
        result: GroupRecommendationResult,
        rightsMode: DataRightsMode,
        aggregation: GroupConstraintAggregation,
    ): Boolean {
        if (!ProviderCodeValidator.isValid(result.provider)) return false
        if (result.name.isBlank() || result.name.length > 120 || result.address.length > 300) return false
        if (rightsMode == DataRightsMode.LIVE_DISPLAY_ONLY && result.fitScore != null) return false
        if (result.fitScore != null && (!result.fitScore.isFinite() || result.fitScore !in 0.0..100.0)) {
            return false
        }
        if (result.sourceRating != null &&
            (!result.sourceRating.isFinite() || result.sourceRating !in 0.0..5.0)
        ) return false
        if (result.averageCostYuan != null &&
            (!result.averageCostYuan.isFinite() || result.averageCostYuan < 0.0)
        ) return false
        if (!result.distanceMeters.isFinite() || result.distanceMeters < 0.0 ||
            result.distanceMeters > aggregation.effectiveRadiusMeters.toDouble()
        ) return false
        if (!result.estimatedTravelMinutes.isFinite() || result.estimatedTravelMinutes < 0.0) {
            return false
        }
        if (!result.estimatedMealMinutes.isFinite() || result.estimatedMealMinutes <= 0.0) {
            return false
        }
        if (result.openStatus == OpenStatus.CLOSED) return false
        val budget = aggregation.effectiveBudgetMaxYuan
        if (budget != null && result.averageCostYuan?.let { it > budget.toDouble() } == true) {
            return false
        }
        if (result.reasons.size !in 1..4 ||
            result.reasons.any { it.text.isBlank() || it.text.length > 120 }
        ) return false
        if (result.tags.size > 20 || result.tags.any { it.isBlank() || it.length > 40 }) return false
        if (result.warnings.size > 20 || result.warnings.any { it.length > 200 }) return false
        if (result.sourceAttribution.isBlank() || result.sourceAttribution.length > 100) return false
        if (containsExcludedCuisine(result.tags, aggregation.excludedCuisines)) return false
        return true
    }

    private fun containsExcludedCuisine(tags: List<String>, exclusions: List<String>): Boolean {
        val normalizedExclusions = exclusions.map(::normalizeCuisine)
        return tags.any { tag ->
            val normalizedTag = normalizeCuisine(tag)
            normalizedTag.isNotEmpty() && normalizedExclusions.any { exclusion ->
                normalizedTag == exclusion || normalizedTag.contains(exclusion)
            }
        }
    }

    private fun normalizeCuisine(value: String): String = value.trim().lowercase(Locale.CHINA)

    private const val GROUP_AGGREGATION_VERSION = "group-constraints-v1"
}
