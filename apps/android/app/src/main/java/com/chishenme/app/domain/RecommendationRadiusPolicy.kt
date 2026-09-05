package com.chishenme.app.domain

import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.PublicRecommendationDefaults

/** Only automatic choices use defaults; explicit user constraints are never clamped. */
object RecommendationRadiusPolicy {
    fun automaticRadius(
        mealPeriod: MealPeriod,
        defaults: PublicRecommendationDefaults?,
    ): Int = defaults?.takeIf(PublicRecommendationDefaults::isValid)?.defaultRadiusMeters
        ?: when (mealPeriod) {
            MealPeriod.BREAKFAST -> 1_000
            MealPeriod.LUNCH -> 1_500
            MealPeriod.DINNER -> 3_000
        }

    fun maximumRadius(defaults: PublicRecommendationDefaults?): Int =
        defaults?.takeIf(PublicRecommendationDefaults::isValid)?.maximumRadiusMeters ?: 10_000

    fun validationMessage(radiusMeters: Int, defaults: PublicRecommendationDefaults?): String? {
        val maximum = maximumRadius(defaults)
        return if (radiusMeters > maximum) {
            "当前服务最远支持 $maximum 米，你选择了 $radiusMeters 米。请调整最远距离后重试。"
        } else {
            null
        }
    }
}
