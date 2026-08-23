package com.chishenme.app.domain

import com.chishenme.app.data.remote.MealPeriod
import org.junit.Assert.assertEquals
import org.junit.Test

class MealPeriodResolverTest {
    @Test
    fun `maps breakfast boundary hours`() {
        assertEquals(MealPeriod.BREAKFAST, MealPeriodResolver.fromHour(5))
        assertEquals(MealPeriod.BREAKFAST, MealPeriodResolver.fromHour(10))
    }

    @Test
    fun `maps lunch boundary hours`() {
        assertEquals(MealPeriod.LUNCH, MealPeriodResolver.fromHour(11))
        assertEquals(MealPeriod.LUNCH, MealPeriodResolver.fromHour(16))
    }

    @Test
    fun `maps remaining hours to dinner`() {
        assertEquals(MealPeriod.DINNER, MealPeriodResolver.fromHour(4))
        assertEquals(MealPeriod.DINNER, MealPeriodResolver.fromHour(17))
        assertEquals(MealPeriod.DINNER, MealPeriodResolver.fromHour(23))
    }
}
