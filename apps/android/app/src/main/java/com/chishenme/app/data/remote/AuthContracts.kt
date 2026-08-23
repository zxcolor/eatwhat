package com.chishenme.app.data.remote

import kotlinx.serialization.Serializable

@Serializable
enum class AuthIdentityType { PHONE, WECHAT, EMAIL, QQ }

@Serializable
enum class OtpPurpose { REGISTER, LOGIN, BIND }

@Serializable
enum class OAuthPurpose { REGISTER, LOGIN, BIND }

@Serializable
data class AuthDeviceContext(
    val installationId: String,
    val label: String,
    val platform: String = "ANDROID",
    val appVersion: String,
)

@Serializable
data class PhoneCodeRequest(
    val phoneNumber: String,
    val purpose: OtpPurpose,
    val installationId: String,
)

@Serializable
data class EmailCodeRequest(
    val email: String,
    val purpose: OtpPurpose,
    val installationId: String,
)

@Serializable
data class AuthCodeChallenge(
    val challengeId: String,
    val targetType: AuthIdentityType,
    val maskedTarget: String,
    val expiresAt: String,
    val resendAvailableAt: String,
)

@Serializable
data class OAuthStateRequest(
    val provider: AuthIdentityType,
    val purpose: OAuthPurpose,
    val installationId: String,
    val phoneChallengeId: String? = null,
)

@Serializable
data class OAuthStateResponse(
    val provider: AuthIdentityType,
    val purpose: OAuthPurpose,
    val state: String,
    val expiresAt: String,
)

@Serializable
data class RegisterPhoneWechatRequest(
    val phoneChallengeId: String,
    val phoneOtpCode: String,
    val wechatOAuthState: String,
    val wechatAuthorizationCode: String,
    val device: AuthDeviceContext,
)

/**
 * The server contract is a discriminated union. Nullable properties are omitted
 * by the shared Json configuration, and repository factory methods below the
 * transport boundary are the only supported way to construct a request.
 */
@Serializable
data class AuthLoginRequest(
    val method: AuthIdentityType,
    val device: AuthDeviceContext,
    val challengeId: String? = null,
    val otpCode: String? = null,
    val oauthState: String? = null,
    val authorizationCode: String? = null,
    val accessToken: String? = null,
)

@Serializable
data class AuthTokenResponse(
    val userId: String,
    val sessionId: String,
    val tokenType: String,
    val accessToken: String,
    val accessTokenExpiresAt: String,
    val refreshToken: String,
    val refreshTokenExpiresAt: String,
)

@Serializable
data class RefreshSessionRequest(
    val refreshToken: String,
    val installationId: String,
)

@Serializable
data class LogoutResponse(
    val sessionId: String,
    val loggedOutAt: String,
)

@Serializable
data class AuthIdentityBinding(
    val bindingId: String,
    val type: AuthIdentityType,
    val maskedValue: String,
    val boundAt: String,
    val primary: Boolean,
    val canUnbind: Boolean,
)

@Serializable
data class AuthIdentityBindingsResponse(
    val items: List<AuthIdentityBinding>,
)

@Serializable
data class BindIdentityRequest(
    val type: AuthIdentityType,
    val challengeId: String? = null,
    val otpCode: String? = null,
    val oauthState: String? = null,
    val accessToken: String? = null,
)

@Serializable
data class BindIdentityResponse(
    val binding: AuthIdentityBinding,
)

@Serializable
data class UnbindIdentityResponse(
    val bindingId: String,
    val unboundAt: String,
)

@Serializable
data class AuthSessionSummary(
    val sessionId: String,
    val deviceLabel: String,
    val platform: String,
    val current: Boolean,
    val createdAt: String,
    val lastActiveAt: String,
    val expiresAt: String,
)

@Serializable
data class AuthSessionsResponse(
    val items: List<AuthSessionSummary>,
)

@Serializable
data class RevokeSessionResponse(
    val sessionId: String,
    val revokedAt: String,
)

@Serializable
data class DeleteAccountRequest(
    val confirmation: String = "DELETE_MY_ACCOUNT",
)

@Serializable
data class DeleteAccountResponse(
    val deletionId: String,
    val userId: String,
    val status: String,
    val invalidatedAt: String,
    val backupDeletionDeadline: String,
)

@Serializable
data class AuthCapabilities(
    val accountsEnabled: Boolean,
    val registrationEnabled: Boolean,
    val phoneEnabled: Boolean,
    val wechatEnabled: Boolean,
    val emailEnabled: Boolean,
    val qqEnabled: Boolean,
    /**
     * Missing on a previously deployed v1 service must fail closed. The
     * server contract applies the same false default before serializing its
     * public feature configuration.
     */
    val dataExportEnabled: Boolean = false,
)
