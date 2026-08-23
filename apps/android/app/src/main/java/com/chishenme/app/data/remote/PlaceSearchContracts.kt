package com.chishenme.app.data.remote

import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class PlaceSearchCoordinate(
    val latitude: Double,
    val longitude: Double,
    val crs: CoordinateReferenceSystem,
)

@Serializable
data class PlaceSearchRequest(
    val location: PlaceSearchCoordinate,
    val mealPeriod: MealPeriod,
    val keyword: String,
    val radiusMeters: Int,
    val maxAverageCostYuan: Int? = null,
    val openNow: Boolean = false,
    val limit: Int = 10,
)

@Serializable
data class PlaceSearchResult(
    val resultToken: String,
    val rank: Int,
    val name: String,
    val address: String?,
    val location: PlaceSearchCoordinate,
    val distanceMeters: Int,
    val sourceLabel: String,
    val sourceRating: Double?,
    val averageCostYuan: Double?,
    val openStatus: OpenStatus,
    val tags: List<String>,
    /**
     * Kept as a validated wire code rather than an enum so a future safe data
     * mode does not crash an older client. UI and persistence never branch on
     * a provider identity; only the exact DEMO/LIVE semantics are recognized.
     */
    val dataMode: String,
    val actions: RecommendationActions,
)

@Serializable
data class PlaceSearchResponse(
    val requestId: String,
    val coverage: Coverage,
    val results: List<PlaceSearchResult>,
    val notice: String?,
)

sealed interface PlaceSearchKeywordValidation {
    data class Valid(val normalizedKeyword: String) : PlaceSearchKeywordValidation
    data class Invalid(val message: String) : PlaceSearchKeywordValidation
}

object PlaceSearchKeywordValidator {
    private const val MAX_KEYWORD_LENGTH = 80
    private val EMBEDDED_COORDINATE = Regex(
        "(?:^|[^\\d])[+-]?(?:\\d{1,3}(?:\\.\\d+)?)\\s*[,，]\\s*" +
            "[+-]?(?:\\d{1,3}(?:\\.\\d+)?)(?=$|[^\\d])",
    )
    private val MOBILE_NUMBER = Regex(
        "(?:^|\\D)(?:\\+?86[-\\s]?)?1[3-9](?:[-\\s]?\\d){9}(?:\\D|$)",
    )
    private val EMAIL_ADDRESS = Regex(
        "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.[A-Za-z]{2,}",
    )

    fun validate(keyword: String): PlaceSearchKeywordValidation {
        if (keyword.any(::isUnsafeControlOrPipe)) {
            return invalid()
        }
        val normalized = keyword.trim()
        return when {
            normalized.isEmpty() -> PlaceSearchKeywordValidation.Invalid("请输入餐厅、菜系或食物关键词")
            normalized.length > MAX_KEYWORD_LENGTH ->
                PlaceSearchKeywordValidation.Invalid("搜索关键词最多 80 个字符")
            '｜' in normalized ||
                EMBEDDED_COORDINATE.containsMatchIn(normalized) ||
                MOBILE_NUMBER.containsMatchIn(normalized) ||
                EMAIL_ADDRESS.containsMatchIn(normalized) -> invalid()
            else -> PlaceSearchKeywordValidation.Valid(normalized)
        }
    }

    private fun invalid() = PlaceSearchKeywordValidation.Invalid(
        "请输入餐厅、菜系或食物关键词，不要输入坐标、手机号、邮箱或分隔符",
    )

    private fun isUnsafeControlOrPipe(character: Char): Boolean =
        character == '|' ||
            character.code <= 0x1f ||
            character.code in 0x7f..0x9f ||
            Character.getType(character) == Character.FORMAT.toInt()
}

object PlaceSearchRequestValidator {
    fun isValid(request: PlaceSearchRequest): Boolean =
        PlaceSearchKeywordValidator.validate(request.keyword) is PlaceSearchKeywordValidation.Valid &&
            request.location.latitude.isFinite() &&
            request.location.latitude in -90.0..90.0 &&
            request.location.longitude.isFinite() &&
            request.location.longitude in -180.0..180.0 &&
            request.radiusMeters in 500..5_000 &&
            (request.maxAverageCostYuan == null || request.maxAverageCostYuan in 1..20_000) &&
            request.limit in 1..10
}

object PlaceSearchResponseValidator {
    fun isValid(response: PlaceSearchResponse, request: PlaceSearchRequest): Boolean {
        if (!isCanonicalUuid(response.requestId)) return false
        if (response.results.size > request.limit || response.results.size > 10) return false
        if (response.notice != null && (response.notice.isBlank() || response.notice.length > 160)) return false
        if (response.coverage == Coverage.OUTSIDE_PILOT && response.results.isNotEmpty()) return false

        val resultTokens = HashSet<String>(response.results.size)
        val ranks = HashSet<Int>(response.results.size)
        return response.results.all { result ->
            resultTokens.add(result.resultToken) &&
                ResultTokenValidator.isValid(result.resultToken) &&
                result.rank in 1..25 &&
                ranks.add(result.rank) &&
                result.name.isNotBlank() &&
                result.name.length <= 160 &&
                !result.name.hasUnsafePresentationCharacters() &&
                result.address?.length.orZero() <= 240 &&
                result.address?.hasUnsafePresentationCharacters() != true &&
                result.location.isValid() &&
                result.distanceMeters in 0..100_000 &&
                result.distanceMeters <= request.radiusMeters &&
                result.sourceLabel.isNotBlank() &&
                result.sourceLabel.length <= 80 &&
                !result.sourceLabel.hasUnsafePresentationCharacters() &&
                result.sourceRating.isNullOrFiniteIn(0.0..5.0) &&
                result.averageCostYuan.isNullOrFiniteIn(0.0..20_000.0) &&
                respectsExplicitFilters(result, request) &&
                result.tags.size <= 20 &&
                result.tags.all {
                    it.isNotBlank() && it.length <= 80 && !it.hasUnsafePresentationCharacters()
                } &&
                ProviderCodeValidator.isValid(result.dataMode) &&
                // Search results never receive a direct-call capability, but
                // DEMO may intentionally exercise the other explicitly granted
                // actions just like the recommendation flow. Data mode is not
                // an authorization switch; each action boolean remains the
                // provider-neutral source of truth and is checked again before
                // Android launches an outbound surface.
                !result.actions.call
        }
    }

    private fun respectsExplicitFilters(result: PlaceSearchResult, request: PlaceSearchRequest): Boolean {
        val maximumCost = request.maxAverageCostYuan
        if (maximumCost != null && result.averageCostYuan != null &&
            result.averageCostYuan > maximumCost.toDouble()
        ) return false
        // UNKNOWN is not evidence of closure and remains visible.
        if (request.openNow && result.openStatus == OpenStatus.CLOSED) return false
        return true
    }

    private fun PlaceSearchCoordinate.isValid(): Boolean =
        latitude.isFinite() &&
            latitude in -90.0..90.0 &&
            longitude.isFinite() &&
            longitude in -180.0..180.0

    private fun Double?.isNullOrFiniteIn(range: ClosedFloatingPointRange<Double>): Boolean =
        this == null || isFinite() && this in range

    private fun isCanonicalUuid(value: String): Boolean =
        value.length == 36 && runCatching {
            UUID.fromString(value).toString().equals(value, ignoreCase = true)
        }.getOrDefault(false)

    private fun Int?.orZero(): Int = this ?: 0

    private fun String.hasUnsafePresentationCharacters(): Boolean = any { character ->
        character.code <= 0x1f ||
            character.code in 0x7f..0x9f ||
            Character.getType(character) == Character.FORMAT.toInt()
    }
}
