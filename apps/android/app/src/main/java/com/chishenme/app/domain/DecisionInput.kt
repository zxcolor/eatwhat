package com.chishenme.app.domain

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationPreferenceVector
import com.chishenme.app.data.remote.RecommendationTarget
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.data.remote.WeatherContextKind
import com.chishenme.app.data.remote.WeatherContextRequest
import java.time.Clock
import java.time.Instant

data class LocationChoice(
    val label: String,
    val coordinate: Coordinate,
    val isDemonstration: Boolean = false,
    val isApproximate: Boolean = false,
)

data class DecisionInput(
    val location: LocationChoice?,
    val mealPeriod: MealPeriod,
    /** Request-scoped only; DecisionHistoryEntry intentionally cannot represent it. */
    val target: RecommendationTarget = RecommendationTarget.MEAL,
    /** User-entered request context only; never a weather observation or persisted field. */
    val weatherContext: WeatherContextRequest = WeatherContextRequest.None,
    val decisionMode: DecisionMode,
    val travelMode: TravelMode,
    val explorationMode: ExplorationMode,
    val budgetMaxYuan: Int?,
    val availableMinutes: Int,
    val radiusMeters: Int,
    val excludedCuisines: Set<String>,
    val preferredCuisines: Set<String>,
)

sealed interface InputValidation {
    data object Valid : InputValidation
    data class Invalid(val message: String) : InputValidation
}

object DecisionInputValidator {
    fun validate(input: DecisionInput): InputValidation = when {
        input.location == null -> InputValidation.Invalid("请先定位或手动选择地点")
        input.budgetMaxYuan != null && input.budgetMaxYuan !in 1..2_000 ->
            InputValidation.Invalid("人均预算需在 1–2000 元之间")
        input.availableMinutes !in 15..240 ->
            InputValidation.Invalid("可用时间需在 15–240 分钟之间")
        input.radiusMeters !in 200..10_000 ->
            InputValidation.Invalid("搜索距离需在 200 米–10 公里之间")
        input.preferredCuisines.size > 20 || input.excludedCuisines.size > 20 ->
            InputValidation.Invalid("菜系选项最多各 20 项")
        input.preferredCuisines.any(input.excludedCuisines::contains) ->
            InputValidation.Invalid("偏好菜系和排除菜系不能重复")
        else -> InputValidation.Valid
    }
}

class RecommendationRequestFactory(
    private val clock: Clock = Clock.systemUTC(),
) {
    fun create(
        input: DecisionInput,
        aiAssistanceEnabled: Boolean = false,
        preferenceVector: RecommendationPreferenceVector = RecommendationPreferenceVector.Default,
    ): RecommendationContext {
        val location = requireNotNull(input.location) { "Location must be validated before creating request" }
        return RecommendationContext(
            location = location.coordinate,
            locationLabel = location.label.take(80),
            mealPeriod = input.mealPeriod,
            target = input.target,
            weatherContext = input.weatherContext,
            decisionMode = input.decisionMode,
            travelMode = input.travelMode,
            explorationMode = input.explorationMode,
            // New specialty/weather modes stay on deterministic rule paths until
            // the model contract explicitly supports their bounded semantics.
            aiAssistanceEnabled = aiAssistanceEnabled &&
                input.target == RecommendationTarget.MEAL &&
                input.mealPeriod == MealPeriod.LUNCH &&
                input.weatherContext.kind == WeatherContextKind.NONE,
            budgetMaxYuan = input.budgetMaxYuan,
            availableMinutes = input.availableMinutes,
            radiusMeters = input.radiusMeters,
            partySize = 1,
            excludedCuisines = input.excludedCuisines.sorted(),
            preferredCuisines = input.preferredCuisines.sorted(),
            preferenceVector = preferenceVector,
            requestTime = Instant.now(clock).toString(),
        )
    }
}

object MealPeriodResolver {
    fun current(clock: Clock = Clock.systemDefaultZone()): MealPeriod {
        val hour = Instant.now(clock).atZone(clock.zone).hour
        return fromHour(hour)
    }

    fun fromHour(hour: Int): MealPeriod {
        require(hour in 0..23)
        return when (hour) {
            in 5..10 -> MealPeriod.BREAKFAST
            in 11..16 -> MealPeriod.LUNCH
            else -> MealPeriod.DINNER
        }
    }
}

object BuiltInQuickLocations {
    val choices: List<LocationChoice> = listOf(
        LocationChoice(
            "北京电子科技学院",
            Coordinate(39.83639, 116.27362, 100.0, CoordinateReferenceSystem.WGS84),
            isDemonstration = true,
        ),
        LocationChoice(
            "北京大学东门",
            Coordinate(39.9928, 116.3109, 80.0, CoordinateReferenceSystem.WGS84),
            isDemonstration = true,
        ),
        LocationChoice(
            "清华大学东门",
            Coordinate(40.0030, 116.3269, 80.0, CoordinateReferenceSystem.WGS84),
            isDemonstration = true,
        ),
        LocationChoice(
            "中国人民大学东门",
            Coordinate(39.9700, 116.3212, 80.0, CoordinateReferenceSystem.WGS84),
            isDemonstration = true,
        ),
        LocationChoice(
            "北京师范大学东门",
            Coordinate(39.9614, 116.3720, 80.0, CoordinateReferenceSystem.WGS84),
            isDemonstration = true,
        ),
        LocationChoice(
            "国贸地铁站",
            Coordinate(39.9091, 116.4612, 100.0, CoordinateReferenceSystem.WGS84),
            isDemonstration = true,
        ),
    )
}
