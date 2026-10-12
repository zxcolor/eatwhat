package com.chishenme.app.data.remote

import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.POST

@Serializable
data class LocationCityCoordinate(
    val latitude: Double,
    val longitude: Double,
    val crs: CoordinateReferenceSystem,
)

@Serializable
data class LocationCityRequest(val location: LocationCityCoordinate)

@Serializable
data class LocationCityResponse(val city: String?)

interface LocationCityApi {
    @POST("v1/location-city")
    suspend fun city(@Body request: LocationCityRequest): LocationCityResponse
}
