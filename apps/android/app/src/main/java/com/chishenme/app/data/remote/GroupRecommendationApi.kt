package com.chishenme.app.data.remote

import retrofit2.http.Body
import retrofit2.http.POST

interface GroupRecommendationApi {
    @POST("v1/group-recommendations")
    suspend fun recommend(
        @Body request: GroupRecommendationRequest,
    ): GroupRecommendationResponse
}
