package com.chishenme.app.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthContractsRedactionTest {
    @Test
    fun `phone challenge request string never exposes phone or installation id`() {
        val phone = "+8613800138000"
        val installationId = "33333333-3333-4333-8333-333333333333"

        val rendered =
            PhoneCodeRequest(
                phoneNumber = phone,
                purpose = OtpPurpose.REGISTER,
                installationId = installationId,
            ).toString()

        assertFalse(rendered.contains(phone))
        assertFalse(rendered.contains(installationId))
        assertTrue(rendered.contains("REDACTED"))
        assertTrue(rendered.contains("REGISTER"))
    }

    @Test
    fun `phone and OAuth DTO string representations never expose credentials or phone`() {
        val phone = "+8613800138000"
        val otp = "123456"
        val oauthState = "private-wechat-oauth-state"
        val authorizationCode = "private-wechat-authorization-code"

        val rendered =
            AuthLoginRequest(
                method = AuthLoginMethod.PHONE,
                device = device(),
                challengeId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
                otpCode = otp,
                phoneNumber = phone,
                oauthState = oauthState,
                authorizationCode = authorizationCode,
            ).toString()

        listOf(phone, otp, oauthState, authorizationCode).forEach { secret ->
            assertFalse(rendered.contains(secret))
        }
        assertTrue(rendered.contains("REDACTED"))
    }

    @Test
    fun `WeChat state binding and device DTO strings redact every proof value`() {
        val installationId = "33333333-3333-4333-8333-333333333333"
        val oauthState = "private-wechat-oauth-state"
        val authorizationCode = "private-wechat-authorization-code"
        val refreshToken = "private-refresh-token"
        val challengeId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f"
        val otpCode = "123456"
        val rendered = listOf(
            device().toString(),
            OAuthStateRequest(
                provider = AuthIdentityType.WECHAT,
                purpose = OAuthPurpose.LOGIN,
                installationId = installationId,
            ).toString(),
            OAuthStateResponse(
                provider = AuthIdentityType.WECHAT,
                purpose = OAuthPurpose.LOGIN,
                state = oauthState,
                expiresAt = "2026-08-21T04:05:00Z",
            ).toString(),
            BindIdentityRequest(
                type = AuthIdentityType.WECHAT,
                challengeId = challengeId,
                otpCode = otpCode,
                oauthState = oauthState,
                authorizationCode = authorizationCode,
            ).toString(),
            RefreshSessionRequest(refreshToken, installationId).toString(),
        ).joinToString("\n")

        listOf(
            installationId,
            oauthState,
            authorizationCode,
            refreshToken,
            challengeId,
            otpCode,
        ).forEach { secret -> assertFalse(rendered.contains(secret)) }
        assertTrue(rendered.contains("REDACTED"))
    }

    private fun device() = AuthDeviceContext(
        installationId = "33333333-3333-4333-8333-333333333333",
        label = "Android test",
        appVersion = "0.1.0",
    )
}
