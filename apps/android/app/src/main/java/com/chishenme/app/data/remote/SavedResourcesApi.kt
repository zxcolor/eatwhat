package com.chishenme.app.data.remote

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

interface SavedResourcesApi {
    @GET("v1/favorites")
    suspend fun listFavorites(
        @Header("Authorization") authorization: String,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: String = "20",
        @Query("group") group: FavoriteGroup? = null,
    ): Response<FavoritesPage>

    @POST("v1/favorites")
    suspend fun createFavorite(
        @Header("Authorization") authorization: String,
        @Body request: FavoriteMutationRequest,
    ): Response<FavoriteRecord>

    @POST("v1/favorites/{favoriteId}/group")
    suspend fun updateFavoriteGroup(
        @Header("Authorization") authorization: String,
        @Path("favoriteId") favoriteId: String,
        @Body request: UpdateFavoriteGroupRequest,
    ): Response<FavoriteRecord>

    @DELETE("v1/favorites/{favoriteId}")
    suspend fun deleteFavorite(
        @Header("Authorization") authorization: String,
        @Path("favoriteId") favoriteId: String,
    ): Response<Unit>

    @GET("v1/history")
    suspend fun listHistory(
        @Header("Authorization") authorization: String,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: String = "20",
        @Query("action") action: RecommendationHistoryAction? = null,
    ): Response<RecommendationHistoryPage>

    @DELETE("v1/history")
    suspend fun clearHistory(
        @Header("Authorization") authorization: String,
    ): Response<Unit>

    @GET("v1/private-feedback")
    suspend fun listPrivateFeedback(
        @Header("Authorization") authorization: String,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: String = "20",
        @Query("type") type: PrivateFeedbackType? = null,
    ): Response<PrivateFeedbackPage>

    @POST("v1/private-feedback")
    suspend fun createPrivateFeedback(
        @Header("Authorization") authorization: String,
        @Body request: CreatePrivateFeedbackRequest,
    ): Response<PrivateFeedbackRecord>

    @DELETE("v1/private-feedback/{feedbackId}")
    suspend fun deletePrivateFeedback(
        @Header("Authorization") authorization: String,
        @Path("feedbackId") feedbackId: String,
    ): Response<Unit>

    @DELETE("v1/private-feedback")
    suspend fun clearPrivateFeedback(
        @Header("Authorization") authorization: String,
    ): Response<Unit>
}
