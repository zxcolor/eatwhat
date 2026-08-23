package com.chishenme.app.data.remote

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST

interface SupportFeedbackApi {
    @POST("v1/support-feedback")
    suspend fun submit(
        @Header("Authorization") authorization: String?,
        @Body request: SupportFeedbackRequest,
    ): Response<SupportFeedbackResponse>
}
