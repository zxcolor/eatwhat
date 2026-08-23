package com.chishenme.app.data.remote

import kotlinx.serialization.Serializable

@Serializable
enum class MealPeriod { BREAKFAST, LUNCH, DINNER }

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
enum class Coverage { BEIJING_FOURTH_RING, OUTSIDE_PILOT }

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

@Serializable
data class RecommendationContext(
    val location: Coordinate,
    val locationLabel: String? = null,
    val mealPeriod: MealPeriod,
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
)

@Serializable
data class ServiceCapabilities(
    val recommendationsEnabled: Boolean = false,
    val locationSearchEnabled: Boolean = false,
    val placeSearchEnabled: Boolean = false,
) {
    companion object {
        val Disabled = ServiceCapabilities()
    }
}

fun FeatureConfig.effectiveServiceCapabilities(): ServiceCapabilities =
    serviceCapabilities ?: ServiceCapabilities.Disabled

fun FeatureConfig.effectivePersistenceCapabilities(): PersistenceCapabilities =
    persistenceCapabilities ?: PersistenceCapabilities.Disabled
