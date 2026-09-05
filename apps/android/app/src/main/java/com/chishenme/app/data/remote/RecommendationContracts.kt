package com.chishenme.app.data.remote

import kotlinx.serialization.Serializable

@Serializable
enum class MealPeriod { BREAKFAST, LUNCH, DINNER }

@Serializable
enum class RecommendationTarget { MEAL, MILK_TEA, COFFEE, DESSERT }

@Serializable
enum class WeatherContextKind { NONE, USER_REPORTED }

@Serializable
enum class UserReportedWeatherPreference { MINIMIZE_EXPOSURE, WARMING, COOLING }

@Serializable
data class WeatherContextRequest(
    val kind: WeatherContextKind = WeatherContextKind.NONE,
    val preference: UserReportedWeatherPreference? = null,
) {
    init {
        require(
            (kind == WeatherContextKind.NONE && preference == null) ||
                (kind == WeatherContextKind.USER_REPORTED && preference != null),
        ) { "User-reported weather requires exactly one bounded preference" }
    }

    companion object {
        val None = WeatherContextRequest()
    }
}

@Serializable
enum class DecisionMode { QUICK, GUIDED }

@Serializable
enum class TravelMode { WALK, BIKE, TRANSIT }

@Serializable
enum class ExplorationMode { SAFE, BALANCED, ADVENTUROUS }

@Serializable
enum class DataRightsMode { LIVE_DISPLAY_ONLY, LICENSED_ENRICHMENT }

@Serializable
enum class Confidence { LOW, MEDIUM, HIGH }

@Serializable
enum class Coverage { NATIONWIDE }

@Serializable
enum class OpenStatus { OPEN, CLOSED, UNKNOWN }

@Serializable
enum class RecommendationEventType { IMPRESSION, DETAIL, NAVIGATION, CALL, REROLL }

@Serializable
enum class SpeedPreference { FAST, NORMAL, RELAXED }

@Serializable
enum class IntentProvider { QWEN, RULE_FALLBACK }

@Serializable
enum class CoordinateReferenceSystem { WGS84, GCJ02 }

@Serializable
enum class RecommendationDataMode { LIVE, DEMO }

@Serializable
data class RecommendationActions(
    val navigate: Boolean,
    val call: Boolean,
    val copyAddress: Boolean,
    val share: Boolean,
)

@Serializable
data class Coordinate(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double? = null,
    /** Required on the wire; provider identity must never imply a coordinate system. */
    val crs: CoordinateReferenceSystem,
)

/**
 * Local user controls for the existing transparent score dimensions.
 * Values are percentages: 100 preserves the established contribution and 0
 * ignores that soft-score dimension. They never weaken hard safety filters.
 */
@Serializable
data class RecommendationPreferenceVector(
    val quality: Int = 100,
    val time: Int = 100,
    val budget: Int = 100,
    val mealMatch: Int = 100,
    val diversity: Int = 100,
) {
    init {
        require(listOf(quality, time, budget, mealMatch, diversity).all { it in 0..100 }) {
            "Recommendation preference weights must be between 0 and 100"
        }
    }

    companion object {
        val Default = RecommendationPreferenceVector()
    }
}

@Serializable
data class RecommendationContext(
    val location: Coordinate,
    val locationLabel: String? = null,
    val mealPeriod: MealPeriod,
    val target: RecommendationTarget = RecommendationTarget.MEAL,
    val weatherContext: WeatherContextRequest = WeatherContextRequest.None,
    val decisionMode: DecisionMode = DecisionMode.QUICK,
    val travelMode: TravelMode = TravelMode.WALK,
    val explorationMode: ExplorationMode = ExplorationMode.BALANCED,
    val aiAssistanceEnabled: Boolean = false,
    val budgetMaxYuan: Int? = null,
    val availableMinutes: Int = 60,
    val radiusMeters: Int,
    val partySize: Int = 1,
    val excludedCuisines: List<String> = emptyList(),
    val preferredCuisines: List<String> = emptyList(),
    val preferenceVector: RecommendationPreferenceVector = RecommendationPreferenceVector.Default,
    val requestTime: String? = null,
)

@Serializable
data class RecommendationReason(
    val code: ReasonCode,
    val text: String,
)

@Serializable
enum class ReasonCode {
    TIME_FIT,
    BUDGET_FIT,
    DISTANCE_FIT,
    MEAL_FIT,
    QUALITY_SIGNAL,
    DIVERSITY,
}

@Serializable
enum class RecommendationProfileFamily {
    MEAL_LEGACY,
    MEAL_BREAKFAST,
    MEAL_LUNCH,
    MEAL_DINNER,
    MILK_TEA,
    COFFEE,
    DESSERT,
}

@Serializable
data class RecommendationProfile(
    val target: RecommendationTarget,
    val family: RecommendationProfileFamily,
    val version: String,
    val providerCapabilityRequired: Boolean,
) {
    companion object {
        val Legacy = RecommendationProfile(
            target = RecommendationTarget.MEAL,
            family = RecommendationProfileFamily.MEAL_LEGACY,
            version = "meal-legacy-v1",
            providerCapabilityRequired = false,
        )
    }
}

@Serializable
enum class WeatherApplicationKind { NONE, USER_REPORTED }

@Serializable
enum class WeatherQueryModifier {
    MINIMIZE_OUTDOOR_EXPOSURE,
    PREFER_WARMING_OPTIONS,
    PREFER_COOLING_OPTIONS,
}

@Serializable
data class WeatherApplication(
    val kind: WeatherApplicationKind,
    val version: String,
    val preference: UserReportedWeatherPreference? = null,
    val queryModifier: WeatherQueryModifier?,
) {
    companion object {
        val None = WeatherApplication(
            kind = WeatherApplicationKind.NONE,
            version = "weather-none-v1",
            queryModifier = null,
        )
    }
}

@Serializable
data class RecommendationResult(
    /** Stable provider code. Unknown valid codes remain forward-compatible. */
    val provider: String,
    /** Opaque, request-scoped public handle. External provider identifiers never cross this boundary. */
    val resultToken: String,
    /** Generic data semantics; provider identity must never drive client behavior. */
    val dataMode: RecommendationDataMode,
    /** Server-authorized outbound actions, enforced again before Android intents are built. */
    val actions: RecommendationActions,
    val name: String,
    val address: String,
    val rank: Int,
    val fitScore: Double?,
    val sourceRating: Double?,
    val averageCostYuan: Double?,
    val distanceMeters: Double,
    val estimatedTravelMinutes: Double,
    val estimatedMealMinutes: Double,
    val openStatus: OpenStatus,
    val tags: List<String>,
    val imageUrl: String?,
    val phone: String?,
    val location: Coordinate,
    val reasons: List<RecommendationReason>,
    val warnings: List<String>,
    val confidence: Confidence,
    val aiAssisted: Boolean,
    val sourceAttribution: String,
)

@Serializable
data class RecommendationResponse(
    val requestId: String,
    val generatedAt: String,
    val coverage: Coverage,
    val dataRightsMode: DataRightsMode,
    val ruleVersion: String,
    val promptVersion: String,
    val modelVersion: String,
    val aiFallbackUsed: Boolean,
    /** Missing on an older v1 response is parsed only as the legacy meal profile. */
    val profile: RecommendationProfile = RecommendationProfile.Legacy,
    /** Missing on an older v1 response is parsed only as no weather application. */
    val weatherApplication: WeatherApplication = WeatherApplication.None,
    val results: List<RecommendationResult>,
    val notice: String?,
)

@Serializable
data class RecommendationEvent(
    val requestId: String,
    val resultToken: String,
    val type: RecommendationEventType,
    val occurredAt: String,
)

@Serializable
data class IntentProfile(
    val cuisineWeights: Map<String, Double>,
    val mealTypes: List<String>,
    val speedPreference: SpeedPreference,
    val diversityTarget: Double,
    val explanationSeed: String,
    val provider: IntentProvider,
)

@Serializable
data class FeatureConfig(
    val coverageName: String,
    val dataRightsMode: DataRightsMode,
    val aiEnabled: Boolean,
    val accountsEnabled: Boolean,
    val favoritesEnabled: Boolean,
    /** Missing on older v1 services means the remote feedback write path is closed. */
    val supportFeedbackEnabled: Boolean = false,
    val minimumSupportedVersion: String,
    val ruleVersion: String,
    val promptVersion: String,
    val modelVersion: String,
    /** Missing on older v1 services means every core remote service is unavailable. */
    val serviceCapabilities: ServiceCapabilities? = null,
    /** Missing on older v1 services means every persistence capability is disabled. */
    val persistenceCapabilities: PersistenceCapabilities? = null,
    val authCapabilities: AuthCapabilities? = null,
    /** Missing as a whole means every post-1.1 target/profile capability is disabled. */
    val specialtyCapabilities: SpecialtyCapabilities? = null,
)

@Serializable
data class SpecialtyCapabilities(
    val breakfastProfileEnabled: Boolean,
    val dinnerProfileEnabled: Boolean,
    val milkTeaEnabled: Boolean,
    val coffeeEnabled: Boolean,
    val dessertEnabled: Boolean,
    val userReportedWeatherEnabled: Boolean,
) {
    companion object {
        val Disabled = SpecialtyCapabilities(
            breakfastProfileEnabled = false,
            dinnerProfileEnabled = false,
            milkTeaEnabled = false,
            coffeeEnabled = false,
            dessertEnabled = false,
            userReportedWeatherEnabled = false,
        )
    }

    fun enables(target: RecommendationTarget): Boolean = when (target) {
        RecommendationTarget.MEAL -> true
        RecommendationTarget.MILK_TEA -> milkTeaEnabled
        RecommendationTarget.COFFEE -> coffeeEnabled
        RecommendationTarget.DESSERT -> dessertEnabled
    }
}

@Serializable
data class ServiceCapabilities(
    val recommendationsEnabled: Boolean = false,
    val locationSearchEnabled: Boolean = false,
    val placeSearchEnabled: Boolean = false,
    /** Missing on older v1 config responses keeps the 2.x group path closed. */
    val groupRecommendationsEnabled: Boolean = false,
) {
    companion object {
        val Disabled = ServiceCapabilities()
    }
}

fun FeatureConfig.effectiveServiceCapabilities(): ServiceCapabilities =
    serviceCapabilities ?: ServiceCapabilities.Disabled

fun FeatureConfig.effectivePersistenceCapabilities(): PersistenceCapabilities =
    persistenceCapabilities ?: PersistenceCapabilities.Disabled

fun FeatureConfig.effectiveSpecialtyCapabilities(): SpecialtyCapabilities =
    if (effectiveServiceCapabilities().recommendationsEnabled) {
        specialtyCapabilities ?: SpecialtyCapabilities.Disabled
    } else {
        SpecialtyCapabilities.Disabled
    }
