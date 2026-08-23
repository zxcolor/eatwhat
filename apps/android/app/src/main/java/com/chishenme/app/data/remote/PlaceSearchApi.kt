package com.chishenme.app.data.remote

import retrofit2.http.Body
import retrofit2.http.POST

interface PlaceSearchApi {
    @POST("v1/place-search")
    suspend fun search(
        @Body request: PlaceSearchRequest,
    ): PlaceSearchResponse
}
