package com.chishenme.app.data.remote

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

@Serializable(with = GroupRecommendationMemberConstraintsSerializer::class)
data class GroupRecommendationMemberConstraints(
    /** Required on the wire; the group Retrofit codec emits an explicit JSON null. */
    val budgetMaxYuan: Int?,
    val availableMinutes: Int,
    val radiusMeters: Int,
    val preferredCuisines: List<String>,
    val excludedCuisines: List<String>,
) {
    init {
        require(budgetMaxYuan == null || budgetMaxYuan in 1..2_000)
        require(availableMinutes in 15..240)
        require(radiusMeters in 200..10_000)
        require(preferredCuisines.size <= MAX_CUISINES_PER_KIND)
        require(excludedCuisines.size <= MAX_CUISINES_PER_KIND)
        require(preferredCuisines.distinct().size == preferredCuisines.size)
        require(excludedCuisines.distinct().size == excludedCuisines.size)
        require((preferredCuisines + excludedCuisines).all(GROUP_CUISINES::contains))
        require(preferredCuisines.none(excludedCuisines::contains))
    }

    private companion object {
        const val MAX_CUISINES_PER_KIND = 8
        val GROUP_CUISINES = setOf(
            "中式快餐",
            "面食",
            "米饭",
            "火锅",
            "川湘菜",
            "清真",
            "素食",
            "西餐",
        )
    }
}

@Serializable
private data class GroupRecommendationMemberConstraintsSurrogate(
    val budgetMaxYuan: Int?,
    val availableMinutes: Int,
    val radiusMeters: Int,
    val preferredCuisines: List<String>,
    val excludedCuisines: List<String>,
)

/** Emits only this contract's required nullable member budget as an explicit null. */
object GroupRecommendationMemberConstraintsSerializer :
    KSerializer<GroupRecommendationMemberConstraints> {
    private val delegate = GroupRecommendationMemberConstraintsSurrogate.serializer()
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: GroupRecommendationMemberConstraints) {
        val jsonEncoder = encoder as? JsonEncoder
            ?: throw SerializationException("Group member constraints require JSON")
        val surrogate = GroupRecommendationMemberConstraintsSurrogate(
            budgetMaxYuan = value.budgetMaxYuan,
            availableMinutes = value.availableMinutes,
            radiusMeters = value.radiusMeters,
            preferredCuisines = value.preferredCuisines,
            excludedCuisines = value.excludedCuisines,
        )
        val encoded = jsonEncoder.json.encodeToJsonElement(delegate, surrogate).jsonObject
        val fields = LinkedHashMap(encoded)
        if (value.budgetMaxYuan == null) fields["budgetMaxYuan"] = JsonNull
        jsonEncoder.encodeJsonElement(JsonObject(fields))
    }

    override fun deserialize(decoder: Decoder): GroupRecommendationMemberConstraints {
        val jsonDecoder = decoder as? JsonDecoder
            ?: throw SerializationException("Group member constraints require JSON")
        val element = jsonDecoder.decodeJsonElement().jsonObject
        if ("budgetMaxYuan" !in element) {
            throw SerializationException("budgetMaxYuan is required")
        }
        val value = jsonDecoder.json.decodeFromJsonElement(delegate, element)
        return GroupRecommendationMemberConstraints(
            budgetMaxYuan = value.budgetMaxYuan,
            availableMinutes = value.availableMinutes,
            radiusMeters = value.radiusMeters,
            preferredCuisines = value.preferredCuisines,
            excludedCuisines = value.excludedCuisines,
        )
    }
}

@Serializable
data class GroupRecommendationRequest(
    val location: Coordinate,
    val travelMode: TravelMode,
    val members: List<GroupRecommendationMemberConstraints>,
) {
    init {
        require(members.size in 2..8)
        require(location.latitude.isFinite() && location.latitude in -90.0..90.0)
        require(location.longitude.isFinite() && location.longitude in -180.0..180.0)
        require(
            location.accuracyMeters?.let {
                it.isFinite() && it in 0.0..10_000.0
            } != false,
        )
    }
}

@Serializable
data class GroupConstraintAggregation(
    val version: String,
    val memberCount: Int,
    val effectiveBudgetMaxYuan: Int?,
    val effectiveAvailableMinutes: Int,
    val effectiveRadiusMeters: Int,
    val preferredCuisines: List<String>,
    val excludedCuisines: List<String>,
)

/**
 * A display-only result. The type intentionally cannot represent tokens,
 * actions, coordinates, phone numbers, images or an AI attribution flag.
 */
@Serializable
data class GroupRecommendationResult(
    val provider: String,
    val dataMode: RecommendationDataMode,
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
    val reasons: List<RecommendationReason>,
    val warnings: List<String>,
    val confidence: Confidence,
    val sourceAttribution: String,
)

@Serializable(with = GroupRecommendationResponseSerializer::class)
data class GroupRecommendationResponse(
    val requestId: String,
    val generatedAt: String,
    val coverage: Coverage,
    val dataRightsMode: DataRightsMode,
    val ruleVersion: String,
    val aggregation: GroupConstraintAggregation,
    val results: List<GroupRecommendationResult>,
    val notice: String?,
)

@Serializable
private data class GroupRecommendationResponseSurrogate(
    val requestId: String,
    val generatedAt: String,
    val coverage: Coverage,
    val dataRightsMode: DataRightsMode,
    val ruleVersion: String,
    val aggregation: GroupConstraintAggregation,
    val results: List<GroupRecommendationResult>,
    val notice: String?,
)

/**
 * Keeps request-side optional null omission while enforcing every required-nullable
 * field in the independent display-only response contract.
 */
@OptIn(ExperimentalSerializationApi::class)
object GroupRecommendationResponseSerializer : KSerializer<GroupRecommendationResponse> {
    private val delegate = GroupRecommendationResponseSurrogate.serializer()
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: GroupRecommendationResponse) {
        val jsonEncoder = encoder as? JsonEncoder
            ?: throw SerializationException("Group recommendation response requires JSON")
        val wireJson = kotlinx.serialization.json.Json(jsonEncoder.json) {
            explicitNulls = true
        }
        wireJson.encodeToJsonElement(
            delegate,
            GroupRecommendationResponseSurrogate(
                requestId = value.requestId,
                generatedAt = value.generatedAt,
                coverage = value.coverage,
                dataRightsMode = value.dataRightsMode,
                ruleVersion = value.ruleVersion,
                aggregation = value.aggregation,
                results = value.results,
                notice = value.notice,
            ),
        ).also(jsonEncoder::encodeJsonElement)
    }

    override fun deserialize(decoder: Decoder): GroupRecommendationResponse {
        val jsonDecoder = decoder as? JsonDecoder
            ?: throw SerializationException("Group recommendation response requires JSON")
        val element = jsonDecoder.decodeJsonElement().jsonObject
        element.requireFields("notice")
        element["aggregation"]?.jsonObject
            ?.requireFields("effectiveBudgetMaxYuan")
            ?: throw SerializationException("aggregation is required")
        element["results"]?.jsonArray?.forEach { result ->
            result.jsonObject.requireFields(
                "fitScore",
                "sourceRating",
                "averageCostYuan",
            )
        } ?: throw SerializationException("results is required")

        val value = jsonDecoder.json.decodeFromJsonElement(delegate, element)
        return GroupRecommendationResponse(
            requestId = value.requestId,
            generatedAt = value.generatedAt,
            coverage = value.coverage,
            dataRightsMode = value.dataRightsMode,
            ruleVersion = value.ruleVersion,
            aggregation = value.aggregation,
            results = value.results,
            notice = value.notice,
        )
    }
}

private fun JsonObject.requireFields(vararg names: String) {
    val missing = names.filterNot(::containsKey)
    if (missing.isNotEmpty()) {
        throw SerializationException("Missing required group response field: ${missing.joinToString()}")
    }
}
