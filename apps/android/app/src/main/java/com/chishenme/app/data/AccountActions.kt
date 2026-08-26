package com.chishenme.app.data

import com.chishenme.app.data.remote.AccountExportResponse
import com.chishenme.app.data.remote.AccountExportStatusResponse
import com.chishenme.app.data.remote.AuthCodeChallenge
import com.chishenme.app.data.remote.AuthIdentityBinding
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthSessionSummary
import com.chishenme.app.data.remote.DeleteAccountResponse
import com.chishenme.app.data.remote.FusionAuthPurpose
import com.chishenme.app.data.remote.FusionAuthTokenResponse
import com.chishenme.app.data.remote.FusionRegistrationPhoneProof
import com.chishenme.app.data.remote.OAuthPurpose
import com.chishenme.app.data.remote.OAuthStateResponse
import com.chishenme.app.data.remote.OtpPurpose

/**
 * The account destination depends on behavior, not repository construction.
 * Keeping these narrow contracts at the repository boundary lets lifecycle
 * tests prove that a disabled remote capability never reaches an export API.
 */
interface AccountAuthActions {
    /** Local-only probe used to keep logout reachable when refresh is unavailable. */
    suspend fun hasLocalSessionMaterial(): Boolean = false

    suspend fun restoreSession(): AuthOutcome<LocalAuthSession?>

    suspend fun requestFusionToken(
        purpose: FusionAuthPurpose,
    ): AuthOutcome<FusionAuthTokenResponse> = AuthOutcome.Failure(
        AuthFailureKind.UNAVAILABLE,
        "当前安装包未开放手机号一键验证",
    )

    suspend fun loginWithFusion(
        flowId: String,
        verifyToken: String,
    ): AuthOutcome<LocalAuthSession> = AuthOutcome.Failure(
        AuthFailureKind.UNAVAILABLE,
        "当前安装包未开放手机号一键验证",
    )

    suspend fun verifyFusionForRegistration(
        flowId: String,
        verifyToken: String,
    ): AuthOutcome<FusionRegistrationPhoneProof> = AuthOutcome.Failure(
        AuthFailureKind.UNAVAILABLE,
        "当前安装包未开放手机号一键验证",
    )

    suspend fun requestPhoneCode(
        rawPhone: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge>

    suspend fun requestEmailCode(
        rawEmail: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge>

    suspend fun createOAuthState(
        provider: AuthIdentityType,
        purpose: OAuthPurpose,
        phoneChallengeId: String? = null,
    ): AuthOutcome<OAuthStateResponse>

    suspend fun createWechatRegistrationStateForFusion(
        phoneProofId: String,
    ): AuthOutcome<OAuthStateResponse> = AuthOutcome.Failure(
        AuthFailureKind.UNAVAILABLE,
        "当前安装包未开放融合认证注册",
    )

    suspend fun registerPhoneWechat(
        challengeId: String,
        otpCode: String,
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession>

    suspend fun registerFusionWechat(
        phoneProofId: String,
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession> = AuthOutcome.Failure(
        AuthFailureKind.UNAVAILABLE,
        "当前安装包未开放融合认证注册",
    )

    suspend fun loginWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
    ): AuthOutcome<LocalAuthSession>

    suspend fun loginWithWechat(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession>

    suspend fun loginWithQq(
        oauthState: String,
        qqAccessToken: String,
    ): AuthOutcome<LocalAuthSession>

    suspend fun identities(): AuthOutcome<List<AuthIdentityBinding>>

    suspend fun bindWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
    ): AuthOutcome<AuthIdentityBinding>

    suspend fun bindWithQq(
        oauthState: String,
        qqAccessToken: String,
    ): AuthOutcome<AuthIdentityBinding>

    suspend fun sessions(): AuthOutcome<List<AuthSessionSummary>>

    suspend fun unbindIdentity(bindingId: String): AuthOutcome<Unit>

    suspend fun revokeSession(sessionId: String): AuthOutcome<Unit>

    suspend fun deleteAccount(): AuthOutcome<DeleteAccountResponse>

    suspend fun logout(): AuthOutcome<Unit>
}

interface AccountExportActions {
    suspend fun request(includeBehaviorHistory: Boolean): AccountExportOutcome<AccountExportResponse>

    suspend fun latest(): AccountExportOutcome<AccountExportStatusResponse?>

    suspend fun download(
        status: AccountExportStatusResponse,
        destinationUri: String,
    ): AccountExportOutcome<Unit>
}
