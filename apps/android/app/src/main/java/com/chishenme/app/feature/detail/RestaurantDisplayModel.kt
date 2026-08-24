package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationResult

/**
 * Provider-neutral presentation facts used by recommendation details. It
 * deliberately contains no fit score, AI reason, provider identifier, precise
 * coordinate or event/history semantics.
 */
internal data class RestaurantDisplayModel(
    val name: String,
    val address: String?,
    val phone: String?,
    val sourceLabel: String,
    val sourceRating: Double?,
    val averageCostYuan: Double?,
    val distanceMeters: Int?,
    val openStatus: OpenStatus,
    val tags: List<String>,
    val dataMode: String,
    val actions: RecommendationActions,
)

internal fun RecommendationResult.toRestaurantDisplayModel() = RestaurantDisplayModel(
    name = name,
    address = address,
    phone = phone,
    sourceLabel = sourceAttribution,
    sourceRating = sourceRating,
    averageCostYuan = averageCostYuan,
    distanceMeters = distanceMeters.toInt().coerceAtLeast(0),
    openStatus = openStatus,
    tags = tags,
    dataMode = dataMode.name,
    actions = actions,
)
