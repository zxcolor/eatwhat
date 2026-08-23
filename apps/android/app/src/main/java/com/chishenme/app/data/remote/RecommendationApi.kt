package com.chishenme.app.data.remote

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface RecommendationApi {
    @GET("v1/config")
    suspend fun featureConfig(): FeatureConfig

    @POST("v1/recommendations")
    suspend fun recommend(
        @Body context: RecommendationContext,
    ): RecommendationResponse

    @POST("v1/recommendation-events")
    suspend fun recordEvent(
        @Body event: RecommendationEvent,
    ): Response<Unit>
}
