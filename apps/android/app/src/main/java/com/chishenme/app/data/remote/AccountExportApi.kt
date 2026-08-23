package com.chishenme.app.data.remote

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

interface AccountExportApi {
    @POST("v1/account/export")
    suspend fun requestExport(
        @Header("Authorization") authorization: String,
        @Body request: AccountExportRequest,
    ): Response<AccountExportResponse>

    @GET("v1/account/exports/latest")
    suspend fun latestExport(
        @Header("Authorization") authorization: String,
    ): Response<AccountExportLatestResponse>

    @GET("v1/account/exports/{exportId}")
    suspend fun exportStatus(
        @Header("Authorization") authorization: String,
        @Path("exportId") exportId: String,
    ): Response<AccountExportStatusResponse>

}
