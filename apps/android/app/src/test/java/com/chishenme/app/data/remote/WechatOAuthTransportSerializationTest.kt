package com.chishenme.app.data.remote

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalSerializationApi::class)
class WechatOAuthTransportSerializationTest {
    private val json = Json { explicitNulls = false }

    @Test
    fun `wechat bind sends state and authorization code without phone proof`() {
        val encoded = json.encodeToString(
            BindIdentityRequest(
                type = AuthIdentityType.WECHAT,
                oauthState = "s".repeat(43),
                authorizationCode = "private-wechat-authorization-code",
            ),
        )

        assertTrue(encoded.contains("\"type\":\"WECHAT\""))
        assertTrue(encoded.contains("\"oauthState\""))
        assertTrue(encoded.contains("\"authorizationCode\""))
        assertFalse(encoded.contains("phoneChallengeId"))
        assertFalse(encoded.contains("phoneProofId"))
        assertFalse(encoded.contains("otpCode"))
        assertFalse(encoded.contains("accessToken"))
    }
}
