package com.chishenme.app.domain

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.TravelMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class DecisionScenarioTest {
    private val location = LocationChoice(
        label = "用户主动选择的位置",
        coordinate = Coordinate(
            latitude = 31.2304,
            longitude = 121.4737,
            accuracyMeters = 80.0,
            crs = CoordinateReferenceSystem.WGS84,
        ),
    )
    private val input = DecisionInput(
        location = location,
        mealPeriod = MealPeriod.DINNER,
        decisionMode = DecisionMode.GUIDED,
        travelMode = TravelMode.BIKE,
        explorationMode = ExplorationMode.BALANCED,
        budgetMaxYuan = null,
        availableMinutes = 60,
        radiusMeters = 2_000,
        partySize = 2,
        excludedCuisines = setOf("火锅"),
        preferredCuisines = setOf("面食"),
    )

    @Test
    fun `every scenario produces a valid input without changing location or cuisines`() {
        DecisionScenario.entries.forEach { scenario ->
            val applied = input.applyScenario(scenario)

            assertSame(location, applied.location)
            assertEquals(setOf("火锅"), applied.excludedCuisines)
            assertEquals(setOf("面食"), applied.preferredCuisines)
            assertEquals(InputValidation.Valid, DecisionInputValidator.validate(applied))
        }
    }

    @Test
    fun `workday lunch applies the promised quick defaults`() {
        val applied = input.applyScenario(DecisionScenario.WORKDAY_LUNCH)

        assertEquals(MealPeriod.LUNCH, applied.mealPeriod)
        assertEquals(DecisionMode.QUICK, applied.decisionMode)
        assertEquals(TravelMode.WALK, applied.travelMode)
        assertEquals(ExplorationMode.BALANCED, applied.explorationMode)
        assertEquals(25, applied.budgetMaxYuan)
        assertEquals(45, applied.availableMinutes)
        assertEquals(1_500, applied.radiusMeters)
        assertEquals(1, applied.partySize)
    }

    @Test
    fun `business trip keeps the meal period while using a bounded nearby search`() {
        val applied = input.applyScenario(DecisionScenario.BUSINESS_TRIP)

        assertEquals(MealPeriod.DINNER, applied.mealPeriod)
        assertEquals(DecisionMode.GUIDED, applied.decisionMode)
        assertEquals(TravelMode.WALK, applied.travelMode)
        assertEquals(60, applied.availableMinutes)
        assertEquals(1_500, applied.radiusMeters)
        assertEquals(1, applied.partySize)
    }

    @Test
    fun `in a hurry favours a short safe walk`() {
        val applied = input.applyScenario(DecisionScenario.IN_A_HURRY)

        assertEquals(MealPeriod.DINNER, applied.mealPeriod)
        assertEquals(DecisionMode.QUICK, applied.decisionMode)
        assertEquals(TravelMode.WALK, applied.travelMode)
        assertEquals(ExplorationMode.SAFE, applied.explorationMode)
        assertEquals(25, applied.budgetMaxYuan)
        assertEquals(30, applied.availableMinutes)
        assertEquals(1_000, applied.radiusMeters)
        assertEquals(1, applied.partySize)
    }

    @Test
    fun `friends gathering expands time distance and party size`() {
        val applied = input.applyScenario(DecisionScenario.FRIENDS_GATHERING)

        assertEquals(MealPeriod.DINNER, applied.mealPeriod)
        assertEquals(DecisionMode.GUIDED, applied.decisionMode)
        assertEquals(TravelMode.TRANSIT, applied.travelMode)
        assertEquals(ExplorationMode.ADVENTUROUS, applied.explorationMode)
        assertEquals(40, applied.budgetMaxYuan)
        assertEquals(90, applied.availableMinutes)
        assertEquals(3_000, applied.radiusMeters)
        assertEquals(3, applied.partySize)
    }
}
