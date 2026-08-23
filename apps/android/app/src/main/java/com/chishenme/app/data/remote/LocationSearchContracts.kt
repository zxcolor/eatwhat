package com.chishenme.app.data.remote

import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class LocationSearchRequest(
    val query: String,
)

@Serializable
enum class LocationSearchDataMode { LIVE, DEMO }

/**
 * Location search keeps CRS mandatory. Unlike the legacy recommendation
 * coordinate contract, a provider response must never silently assume WGS84.
 */
@Serializable
data class LocationSearchCoordinate(
    val latitude: Double,
    val longitude: Double,
    val crs: CoordinateReferenceSystem,
)

@Serializable
data class LocationSearchPlace(
    val name: String,
    val address: String? = null,
    val location: LocationSearchCoordinate,
    val sourceLabel: String,
    val providerRank: Int,
)

@Serializable
data class LocationSearchResponse(
    val requestId: String,
    /** Stable provider code, e.g. AMAP or DEMO. Unknown valid codes remain forward-compatible. */
    val dataSource: String,
    /** Generic capability mode; provider identity never drives client behavior. */
    val dataMode: LocationSearchDataMode,
    val results: List<LocationSearchPlace>,
    val notice: String? = null,
)

sealed interface LocationSearchQueryValidation {
    data class Valid(val normalizedQuery: String) : LocationSearchQueryValidation
    data class Invalid(val message: String) : LocationSearchQueryValidation
}

object LocationSearchQueryValidator {
    private const val MAX_QUERY_LENGTH = 80
    private val COORDINATE_PAIR = Regex(
        "(?:^|\\s)[+-]?(?:\\d{1,3}(?:\\.\\d+)?)\\s*[,，]\\s*" +
            "[+-]?(?:\\d{1,3}(?:\\.\\d+)?)(?:\\s|$)",
    )
    private val MOBILE_NUMBER = Regex("(?<!\\d)(?:\\+?86)?1[3-9]\\d{9}(?!\\d)")
    private val EMAIL_ADDRESS = Regex(
        "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.[A-Za-z]{2,}",
    )

    fun validate(query: String): LocationSearchQueryValidation {
        if (query.any { it.isISOControl() }) {
            return LocationSearchQueryValidation.Invalid("请输入单行地点关键词，不要包含控制字符")
        }
        val normalized = query.trim().replace(Regex("\\s+"), " ")
        return when {
            normalized.length < 2 -> LocationSearchQueryValidation.Invalid("请至少输入 2 个字符")
            normalized.length > MAX_QUERY_LENGTH ->
                LocationSearchQueryValidation.Invalid("地点关键词最多 80 个字符")
            '|' in normalized -> LocationSearchQueryValidation.Invalid("地点关键词不能包含管道符号")
            COORDINATE_PAIR.containsMatchIn(normalized) ->
                LocationSearchQueryValidation.Invalid("请搜索地点名称或地址，不要输入经纬度")
            MOBILE_NUMBER.containsMatchIn(normalized.replace(" ", "").replace("-", "")) ->
                LocationSearchQueryValidation.Invalid("请勿在地点搜索中输入手机号")
            EMAIL_ADDRESS.containsMatchIn(normalized) ->
                LocationSearchQueryValidation.Invalid("请勿在地点搜索中输入邮箱地址")
            else -> LocationSearchQueryValidation.Valid(normalized)
        }
    }
}

object LocationSearchResponseValidator {
    fun isValid(response: LocationSearchResponse): Boolean {
        if (!isCanonicalUuid(response.requestId) || response.results.size > 5) {
            return false
        }
        if (!ProviderCodeValidator.isValid(response.dataSource)) return false
        if (response.notice?.length.orZero() > 500) return false

        val ranks = HashSet<Int>(response.results.size)
        return response.results.all { place ->
            place.name.isNotBlank() &&
                place.name.length <= 120 &&
                place.address?.length.orZero() <= 200 &&
                place.sourceLabel.isNotBlank() &&
                place.sourceLabel.length <= 80 &&
                place.providerRank in 1..5 &&
                ranks.add(place.providerRank) &&
                place.location.latitude.isFinite() &&
                place.location.latitude in -90.0..90.0 &&
                place.location.longitude.isFinite() &&
                place.location.longitude in -180.0..180.0
        }
    }

    private fun isCanonicalUuid(value: String): Boolean =
        value.length == 36 && runCatching {
            UUID.fromString(value).toString().equals(value, ignoreCase = true)
        }.getOrDefault(false)

    private fun Int?.orZero(): Int = this ?: 0
}
