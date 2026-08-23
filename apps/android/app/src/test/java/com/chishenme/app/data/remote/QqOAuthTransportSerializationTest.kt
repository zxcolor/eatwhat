package com.chishenme.app.data.remote

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalSerializationApi::class)
class QqOAuthTransportSerializationTest {
    private val json = Json { explicitNulls = false }

    @Test
    fun `QQ login sends only backend state access token and device context`() {
        val encoded = json.encodeToString(
            AuthLoginRequest(
                method = AuthIdentityType.QQ,
                oauthState = "s".repeat(43),
                accessToken = "private-access-token-1234567890",
                device = AuthDeviceContext(
                    installationId = "11111111-1111-4111-8111-111111111111",
                    label = "Android 设备",
                    appVersion = "1.0.0",
                ),
            ),
        )

        assertTrue(encoded.contains("\"method\":\"QQ\""))
        assertTrue(encoded.contains("\"oauthState\""))
        assertTrue(encoded.contains("\"accessToken\""))
        assertTrue(encoded.contains("\"installationId\""))
        assertFalse(encoded.contains("openId", ignoreCase = true))
        assertFalse(encoded.contains("authorizationCode"))
        assertFalse(encoded.contains("challengeId"))
    }

    @Test
    fun `QQ bind omits client account identity and unrelated proofs`() {
        val encoded = json.encodeToString(
            BindIdentityRequest(
                type = AuthIdentityType.QQ,
                oauthState = "b".repeat(43),
                accessToken = "private-access-token-1234567890",
            ),
        )

        assertFalse(encoded.contains("openId", ignoreCase = true))
        assertFalse(encoded.contains("authorizationCode"))
        assertFalse(encoded.contains("challengeId"))
        assertFalse(encoded.contains("otpCode"))
    }
}
