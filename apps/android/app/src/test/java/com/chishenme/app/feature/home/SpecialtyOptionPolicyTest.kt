package com.chishenme.app.feature.home

import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.RecommendationTarget
import com.chishenme.app.data.remote.SpecialtyCapabilities
import org.junit.Assert.assertEquals
import org.junit.Test

class SpecialtyOptionPolicyTest {
    @Test
    fun `missing capabilities expose no vertical targets and only lunch`() {
        assertEquals(emptyList<Pair<RecommendationTarget, String>>(), specialtyTargetOptions(null))
        assertEquals(listOf(MealPeriod.LUNCH to "午餐"), mealPeriodOptions(null))
    }

    @Test
    fun `each atomic capability controls only its matching visible option`() {
        assertEquals(
            listOf(RecommendationTarget.MILK_TEA to "奶茶"),
            specialtyTargetOptions(SpecialtyCapabilities.Disabled.copy(milkTeaEnabled = true)),
        )
        assertEquals(
            listOf(RecommendationTarget.COFFEE to "咖啡"),
            specialtyTargetOptions(SpecialtyCapabilities.Disabled.copy(coffeeEnabled = true)),
        )
        assertEquals(
            listOf(RecommendationTarget.DESSERT to "甜品"),
            specialtyTargetOptions(SpecialtyCapabilities.Disabled.copy(dessertEnabled = true)),
        )
        assertEquals(
            listOf(MealPeriod.BREAKFAST to "早餐", MealPeriod.LUNCH to "午餐"),
            mealPeriodOptions(
                SpecialtyCapabilities.Disabled.copy(breakfastProfileEnabled = true),
            ),
        )
        assertEquals(
            listOf(MealPeriod.LUNCH to "午餐", MealPeriod.DINNER to "晚餐"),
            mealPeriodOptions(
                SpecialtyCapabilities.Disabled.copy(dinnerProfileEnabled = true),
            ),
        )
    }
}
