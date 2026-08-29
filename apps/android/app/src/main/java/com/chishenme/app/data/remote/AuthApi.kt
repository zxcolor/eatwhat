package com.chishenme.app.data.remote

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

interface AuthApi {
    @POST("v1/auth/phone/request-code")
    suspend fun requestPhoneCode(
        @Header("Authorization") authorization: String?,
        @Body request: PhoneCodeRequest,
    ): AuthCodeChallenge

    @POST("v1/auth/email/request-code")
    suspend fun requestEmailCode(
        @Header("Authorization") authorization: String?,
        @Body request: EmailCodeRequest,
    ): AuthCodeChallenge

    @POST("v1/auth/oauth/state")
    suspend fun createOAuthState(
        @Header("Authorization") authorization: String?,
        @Body request: OAuthStateRequest,
    ): OAuthStateResponse

    @POST("v1/auth/login")
    suspend fun login(@Body request: AuthLoginRequest): AuthTokenResponse

    @POST("v1/auth/refresh")
    suspend fun refresh(@Body request: RefreshSessionRequest): AuthTokenResponse

    @POST("v1/auth/logout")
    suspend fun logout(
        @Header("Authorization") authorization: String,
        @Body emptyBody: Map<String, String> = emptyMap(),
    ): LogoutResponse

    @GET("v1/auth/identities")
    suspend fun identities(
        @Header("Authorization") authorization: String,
    ): AuthIdentityBindingsResponse

    @POST("v1/auth/identities")
    suspend fun bindIdentity(
        @Header("Authorization") authorization: String,
        @Body request: BindIdentityRequest,
    ): BindIdentityResponse

    @DELETE("v1/auth/identities/{bindingId}")
    suspend fun unbindIdentity(
        @Header("Authorization") authorization: String,
        @Path("bindingId") bindingId: String,
    ): UnbindIdentityResponse

    @GET("v1/auth/sessions")
    suspend fun sessions(
        @Header("Authorization") authorization: String,
    ): AuthSessionsResponse

    @DELETE("v1/auth/sessions/{sessionId}")
    suspend fun revokeSession(
        @Header("Authorization") authorization: String,
        @Path("sessionId") sessionId: String,
    ): RevokeSessionResponse

    @HTTP(method = "DELETE", path = "v1/account", hasBody = true)
    suspend fun deleteAccount(
        @Header("Authorization") authorization: String,
        @Body request: DeleteAccountRequest,
    ): DeleteAccountResponse
}
