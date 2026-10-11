package com.chishenme.app.data.remote

import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.POST

@Serializable
data class NearbyRestaurantCoordinate(
    val latitude: Double,
    val longitude: Double,
    val crs: CoordinateReferenceSystem,
)

@Serializable
data class NearbyRestaurantRequest(val location: NearbyRestaurantCoordinate, val page: Int)

@Serializable
data class NearbyRestaurant(
    val provider: String,
    val providerPlaceId: String,
    val name: String,
    val address: String,
    val location: NearbyRestaurantCoordinate,
    val sourceRating: Double?,
    val averageCostYuan: Double?,
    val openStatus: OpenStatus,
    val tags: List<String>,
    val phone: String?,
    val sourceAttribution: String,
    val dataMode: RecommendationDataMode,
)

@Serializable
data class NearbyRestaurantResponse(
    val radiusMeters: Int,
    val retentionDays: Int,
    val page: Int,
    val nextPage: Int?,
    val truncated: Boolean,
    val restaurants: List<NearbyRestaurant>,
)

interface NearbyRestaurantsApi {
    @POST("v1/restaurants/nearby")
    suspend fun collect(@Body request: NearbyRestaurantRequest): NearbyRestaurantResponse
}
