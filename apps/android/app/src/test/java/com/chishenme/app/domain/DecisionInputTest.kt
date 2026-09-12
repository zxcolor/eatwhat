package com.chishenme.app.domain

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.RecommendationPreferenceVector
import com.chishenme.app.data.remote.RecommendationTarget
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.data.remote.UserReportedWeatherPreference
import com.chishenme.app.data.remote.WeatherContextKind
import com.chishenme.app.data.remote.WeatherContextRequest
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
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
        assertEquals(1, request.partySize)
        assertEquals(listOf("火锅"), request.excludedCuisines)
        assertEquals(listOf("面食"), request.preferredCuisines)
        assertEquals(false, request.aiAssistanceEnabled)
        assertEquals(RecommendationTarget.MEAL, request.target)
        assertEquals(WeatherContextRequest.None, request.weatherContext)
        assertEquals("2026-08-20T04:00:00Z", request.requestTime)
    }

    @Test
    fun `vertical target alone keeps AI off`() {
        val special = validInput.copy(
            target = RecommendationTarget.COFFEE,
        )

        val request = RecommendationRequestFactory().create(
            special,
            aiAssistanceEnabled = true,
        )

        assertEquals(RecommendationTarget.COFFEE, request.target)
        assertEquals(WeatherContextRequest.None, request.weatherContext)
        assertEquals(false, request.aiAssistanceEnabled)
    }

    @Test
    fun `user reported weather alone keeps AI off`() {
        val request = RecommendationRequestFactory().create(
            validInput.copy(
                weatherContext = WeatherContextRequest(
                    kind = WeatherContextKind.USER_REPORTED,
                    preference = UserReportedWeatherPreference.WARMING,
                ),
            ),
            aiAssistanceEnabled = true,
        )

        assertEquals(RecommendationTarget.MEAL, request.target)
        assertEquals(UserReportedWeatherPreference.WARMING, request.weatherContext.preference)
        assertEquals(false, request.aiAssistanceEnabled)
    }

    @Test
    fun `lunch meal baseline preserves an explicitly enabled AI request`() {
        val request = RecommendationRequestFactory().create(
            validInput,
            aiAssistanceEnabled = true,
        )

        assertEquals(MealPeriod.LUNCH, request.mealPeriod)
        assertEquals(RecommendationTarget.MEAL, request.target)
        assertEquals(WeatherContextRequest.None, request.weatherContext)
        assertEquals(true, request.aiAssistanceEnabled)
    }

    @Test
    fun `breakfast and dinner profiles keep AI off until model contract support exists`() {
        for (period in listOf(MealPeriod.BREAKFAST, MealPeriod.DINNER)) {
            val request = RecommendationRequestFactory().create(
                validInput.copy(mealPeriod = period),
                aiAssistanceEnabled = true,
            )

            assertEquals(period, request.mealPeriod)
            assertEquals(false, request.aiAssistanceEnabled)
        }
    }

    @Test
    fun `request factory defaults AI assistance off`() {
        val request = RecommendationRequestFactory().create(validInput)

        assertEquals(false, request.aiAssistanceEnabled)
        assertEquals(RecommendationPreferenceVector.Default, request.preferenceVector)
    }

    @Test
    fun `request factory sends only the current bounded preference vector`() {
        val preferences = RecommendationPreferenceVector(
            quality = 80,
            time = 95,
            budget = 60,
            mealMatch = 75,
            diversity = 30,
        )

        val request = RecommendationRequestFactory().create(
            validInput,
            aiAssistanceEnabled = false,
            preferenceVector = preferences,
        )

        assertEquals(preferences, request.preferenceVector)
    }

    @Test
    fun `preference vector rejects out of range weights before serialization`() {
        assertThrows(IllegalArgumentException::class.java) {
            RecommendationPreferenceVector(quality = 101)
        }
    }

    @Test
    fun `rejects location missing`() {
        val validation = DecisionInputValidator.validate(validInput.copy(location = null))
        assertTrue(validation is InputValidation.Invalid)
    }

    @Test
    fun `v1 compatibility field cannot create a multiple diner request`() {
        val request = RecommendationRequestFactory().create(validInput)
        for (invalid in listOf(0, 2, 30)) {
            assertThrows(IllegalArgumentException::class.java) {
                request.copy(partySize = invalid)
            }
        }
    }

    @Test
    fun `rejects cuisine in both preferred and excluded sets`() {
        val validation = DecisionInputValidator.validate(
            validInput.copy(excludedCuisines = setOf("面食"), preferredCuisines = setOf("面食")),
        )
        assertTrue(validation is InputValidation.Invalid)
    }
}
