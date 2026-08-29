package com.chishenme.app.data.remote

import kotlinx.serialization.Serializable

@Serializable
enum class AuthIdentityType { PHONE, WECHAT, EMAIL, QQ }

@Serializable
enum class OtpPurpose { REGISTER, LOGIN, BIND }

@Serializable
enum class OAuthPurpose { REGISTER, LOGIN, BIND }

@Serializable
enum class AuthLoginMethod { PHONE, EMAIL, WECHAT, QQ }

@Serializable
data class AuthDeviceContext(
    val installationId: String,
    val label: String,
    val platform: String = "ANDROID",
    val appVersion: String,
) {
    override fun toString(): String =
        "AuthDeviceContext(installationId=REDACTED, label=$label, " +
            "platform=$platform, appVersion=$appVersion)"
}

@Serializable
data class PhoneCodeRequest(
    val phoneNumber: String,
    val purpose: OtpPurpose,
    val installationId: String,
) {
    override fun toString(): String =
        "PhoneCodeRequest(phoneNumber=REDACTED, purpose=$purpose, installationId=REDACTED)"
}

@Serializable
data class EmailCodeRequest(
    val email: String,
    val purpose: OtpPurpose,
    val installationId: String,
) {
    override fun toString(): String =
        "EmailCodeRequest(email=REDACTED, purpose=$purpose, installationId=REDACTED)"
}

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
) {
    override fun toString(): String =
        "OAuthStateRequest(provider=$provider, purpose=$purpose, installationId=REDACTED)"
}

@Serializable
data class OAuthStateResponse(
    val provider: AuthIdentityType,
    val purpose: OAuthPurpose,
    val state: String,
    val expiresAt: String,
) {
    override fun toString(): String =
        "OAuthStateResponse(provider=$provider, purpose=$purpose, state=REDACTED, " +
            "expiresAt=$expiresAt)"
}

/**
 * The server contract is a discriminated union. Nullable properties are omitted
 * by the shared Json configuration, and repository factory methods below the
 * transport boundary are the only supported way to construct a request.
 */
@Serializable
data class AuthLoginRequest(
    val method: AuthLoginMethod,
    val device: AuthDeviceContext,
    val challengeId: String? = null,
    val otpCode: String? = null,
    val phoneNumber: String? = null,
    val oauthState: String? = null,
    val authorizationCode: String? = null,
) {
    override fun toString(): String =
        "AuthLoginRequest(method=$method, device=$device, challengeId=$challengeId, " +
            "otpCode=${otpCode.redacted()}, phoneNumber=${phoneNumber.redacted()}, " +
            "oauthState=${oauthState.redacted()}, " +
            "authorizationCode=${authorizationCode.redacted()})"

    private fun String?.redacted(): String? = if (this == null) null else "REDACTED"
}

@Serializable
data class AuthTokenResponse(
    val userId: String,
    val sessionId: String,
    val tokenType: String,
    val accessToken: String,
    val accessTokenExpiresAt: String,
    val refreshToken: String,
    val refreshTokenExpiresAt: String,
) {
    override fun toString(): String = "AuthTokenResponse(REDACTED)"
}

@Serializable
data class RefreshSessionRequest(
    val refreshToken: String,
    val installationId: String,
) {
    override fun toString(): String =
        "RefreshSessionRequest(refreshToken=REDACTED, installationId=REDACTED)"
}

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
    val authorizationCode: String? = null,
) {
    override fun toString(): String =
        "BindIdentityRequest(type=$type, challengeId=${challengeId.redacted()}, " +
            "otpCode=${otpCode.redacted()}, oauthState=${oauthState.redacted()}, " +
            "authorizationCode=${authorizationCode.redacted()})"
}

@Serializable
internal data class AuthErrorResponse(
    val requestId: String,
    val code: String,
    val message: String,
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

private fun String?.redacted(): String? = if (this == null) null else "REDACTED"
