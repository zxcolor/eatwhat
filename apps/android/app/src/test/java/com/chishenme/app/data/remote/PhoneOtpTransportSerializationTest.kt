package com.chishenme.app.data.remote

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalSerializationApi::class)
class PhoneOtpTransportSerializationTest {
    private val json = Json { explicitNulls = false }

    @Test
    fun `phone verification carries the original phone with challenge and OTP`() {
        val encoded = json.encodeToString(
            AuthLoginRequest(
                method = AuthLoginMethod.PHONE,
                challengeId = "11111111-1111-4111-8111-111111111111",
                otpCode = "123456",
                phoneNumber = "+8613800138000",
                device = AuthDeviceContext(
                    installationId = "22222222-2222-4222-8222-222222222222",
                    label = "Android 设备",
                    appVersion = "1.0.0",
                ),
            ),
        )

        assertTrue(encoded.contains("\"method\":\"PHONE\""))
        assertTrue(encoded.contains("\"challengeId\""))
        assertTrue(encoded.contains("\"otpCode\""))
        assertTrue(encoded.contains("\"phoneNumber\":\"+8613800138000\""))
        assertFalse(encoded.contains("oauthState"))
        assertFalse(encoded.contains("authorizationCode"))
        assertFalse(encoded.contains("accessToken"))
    }

    @Test
    fun `email login does not serialize a phone number`() {
        val encoded = json.encodeToString(
            AuthLoginRequest(
                method = AuthLoginMethod.EMAIL,
                challengeId = "11111111-1111-4111-8111-111111111111",
                otpCode = "123456",
                device = AuthDeviceContext(
                    installationId = "22222222-2222-4222-8222-222222222222",
                    label = "Android 设备",
                    appVersion = "1.0.0",
                ),
            ),
        )

        assertFalse(encoded.contains("phoneNumber"))
    }

    @Test
    fun `email code and bind bodies contain only the OTP contract fields`() {
        val emailRequest = json.encodeToString(
            EmailCodeRequest(
                email = "user@example.com",
                purpose = OtpPurpose.BIND,
                installationId = "22222222-2222-4222-8222-222222222222",
            ),
        )
        val bindRequest = json.encodeToString(
            BindIdentityRequest(
                type = AuthIdentityType.EMAIL,
                challengeId = "11111111-1111-4111-8111-111111111111",
                otpCode = "123456",
            ),
        )

        assertTrue(emailRequest.contains("\"email\":\"user@example.com\""))
        assertTrue(emailRequest.contains("\"purpose\":\"BIND\""))
        assertTrue(emailRequest.contains("\"installationId\""))
        assertTrue(bindRequest.contains("\"type\":\"EMAIL\""))
        assertTrue(bindRequest.contains("\"challengeId\""))
        assertTrue(bindRequest.contains("\"otpCode\""))
        assertFalse(bindRequest.contains("phoneNumber"))
        assertFalse(bindRequest.contains("email"))
        assertFalse(bindRequest.contains("oauthState"))
        assertFalse(bindRequest.contains("authorizationCode"))
        assertFalse(bindRequest.contains("accessToken"))
    }
}
