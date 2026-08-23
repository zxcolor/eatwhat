package com.chishenme.app.data.remote

import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.Path
import retrofit2.http.Streaming

/** Isolated so only the user-initiated byte stream receives extended timeouts. */
interface AccountExportContentApi {
    @Streaming
    @GET("v1/account/exports/{exportId}/content")
    suspend fun exportContent(
        @Header("Authorization") authorization: String,
        @Path("exportId") exportId: String,
    ): Response<ResponseBody>
}
