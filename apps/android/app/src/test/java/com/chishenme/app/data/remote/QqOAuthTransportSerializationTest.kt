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
    fun `QQ login sends only backend state authorization code and device context`() {
        val encoded = json.encodeToString(
            AuthLoginRequest(
                method = AuthLoginMethod.QQ,
                oauthState = "s".repeat(43),
                authorizationCode = "private-authorization-code-1234567890",
                device = AuthDeviceContext(
                    installationId = "11111111-1111-4111-8111-111111111111",
                    label = "Android 设备",
                    appVersion = "1.0.0",
                ),
            ),
        )

        assertTrue(encoded.contains("\"method\":\"QQ\""))
        assertTrue(encoded.contains("\"oauthState\""))
        assertTrue(encoded.contains("\"authorizationCode\""))
        assertTrue(encoded.contains("\"installationId\""))
        assertFalse(encoded.contains("openId", ignoreCase = true))
        assertFalse(encoded.contains("accessToken"))
        assertFalse(encoded.contains("challengeId"))
    }

    @Test
    fun `QQ bind omits client account identity and unrelated proofs`() {
        val encoded = json.encodeToString(
            BindIdentityRequest(
                type = AuthIdentityType.QQ,
                oauthState = "b".repeat(43),
                authorizationCode = "private-authorization-code-1234567890",
            ),
        )

        assertFalse(encoded.contains("openId", ignoreCase = true))
        assertTrue(encoded.contains("\"authorizationCode\""))
        assertFalse(encoded.contains("accessToken"))
        assertFalse(encoded.contains("challengeId"))
        assertFalse(encoded.contains("otpCode"))
    }
}
