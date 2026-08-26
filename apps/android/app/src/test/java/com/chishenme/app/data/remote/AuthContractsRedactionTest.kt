package com.chishenme.app.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthContractsRedactionTest {
    @Test
    fun `fusion DTO string representations never expose raw tokens or proofs`() {
        val authToken = "private-fusion-auth-token"
        val verifyToken = "private-fusion-verify-token"
        val proofId = "private-fusion-phone-proof"
        val oauthState = "private-wechat-oauth-state"
        val authorizationCode = "private-wechat-authorization-code"

        val values = listOf(
            FusionAuthTokenResponse(
                flowId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
                schemeCode = "scheme-100001",
                authToken = authToken,
                expiresAt = "2026-08-26T04:10:00Z",
            ).toString(),
            FusionRegistrationVerifyRequest(
                flowId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
                verifyToken = verifyToken,
                installationId = "33333333-3333-4333-8333-333333333333",
            ).toString(),
            FusionRegistrationPhoneProof(
                proofId = proofId,
                expiresAt = "2026-08-26T04:10:00Z",
            ).toString(),
            AuthLoginRequest(
                method = AuthLoginMethod.PHONE_FUSION,
                device = device(),
                flowId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
                verifyToken = verifyToken,
            ).toString(),
            RegisterFusionWechatRequest(
                phoneProofId = proofId,
                wechatOAuthState = oauthState,
                wechatAuthorizationCode = authorizationCode,
                device = device(),
            ).toString(),
        )

        values.forEach { rendered ->
            listOf(authToken, verifyToken, proofId, oauthState, authorizationCode).forEach { secret ->
                assertFalse(rendered.contains(secret))
            }
            assertTrue(rendered.contains("REDACTED"))
        }
    }

    private fun device() = AuthDeviceContext(
        installationId = "33333333-3333-4333-8333-333333333333",
        label = "Android test",
        appVersion = "0.1.0",
    )
}
