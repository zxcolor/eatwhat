package com.chishenme.app.domain

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.TravelMode
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DecisionInputTest {
    private val validInput = DecisionInput(
        location = LocationChoice(
            "北京大学东门",
            Coordinate(39.9928, 116.3109, 80.0, CoordinateReferenceSystem.WGS84),
        ),
        mealPeriod = MealPeriod.LUNCH,
        decisionMode = DecisionMode.GUIDED,
        travelMode = TravelMode.WALK,
        explorationMode = ExplorationMode.BALANCED,
        budgetMaxYuan = 25,
        availableMinutes = 45,
        radiusMeters = 1_500,
        partySize = 1,
        excludedCuisines = setOf("火锅"),
        preferredCuisines = setOf("面食"),
    )

    @Test
    fun `puts Beijing Electronic Science and Technology Institute first`() {
        val first = BuiltInQuickLocations.choices.first()

        assertEquals("北京电子科技学院", first.label)
    }

    @Test
    fun `builds privacy minimal contract request`() {
        val fixed = Instant.parse("2026-08-20T04:00:00Z")
        val request = RecommendationRequestFactory(Clock.fixed(fixed, ZoneOffset.UTC))
            .create(validInput, aiAssistanceEnabled = false)

        assertEquals("北京大学东门", request.locationLabel)
        assertEquals(39.9928, request.location.latitude, 0.00001)
        assertEquals(CoordinateReferenceSystem.WGS84, request.location.crs)
        assertEquals(25, request.budgetMaxYuan)
        assertEquals(listOf("火锅"), request.excludedCuisines)
        assertEquals(listOf("面食"), request.preferredCuisines)
        assertEquals(false, request.aiAssistanceEnabled)
        assertEquals("2026-08-20T04:00:00Z", request.requestTime)
    }

    @Test
    fun `request factory defaults AI assistance off`() {
        val request = RecommendationRequestFactory().create(validInput)

        assertEquals(false, request.aiAssistanceEnabled)
    }

    @Test
    fun `rejects location missing`() {
        val validation = DecisionInputValidator.validate(validInput.copy(location = null))
        assertTrue(validation is InputValidation.Invalid)
    }

    @Test
    fun `rejects cuisine in both preferred and excluded sets`() {
        val validation = DecisionInputValidator.validate(
            validInput.copy(excludedCuisines = setOf("面食"), preferredCuisines = setOf("面食")),
        )
        assertTrue(validation is InputValidation.Invalid)
    }
}
