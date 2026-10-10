package com.chishenme.app.data.remote

import java.time.Instant
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthResponseValidatorTest {
    private val now = Instant.parse("2026-08-21T00:00:00Z")

    @Test
    fun `accepts bounded server token response and rejects substitution`() {
        val response = validTokens()
        assertTrue(AuthResponseValidator.validTokens(response, now))
        assertFalse(
            AuthResponseValidator.validTokens(
                response.copy(refreshToken = response.accessToken),
                now,
            ),
        )
        assertFalse(
            AuthResponseValidator.validTokens(
                response.copy(sessionId = "not-a-session"),
                now,
            ),
        )
    }

    @Test
    fun `challenge enforces expected channel mask and bounded time`() {
        val challenge = AuthCodeChallenge(
            challengeId = "11111111-1111-4111-8111-111111111111",
            targetType = AuthIdentityType.PHONE,
            maskedTarget = "+86138****1234",
            expiresAt = now.plusSeconds(300).toString(),
            resendAvailableAt = now.plusSeconds(60).toString(),
        )
        assertTrue(AuthResponseValidator.validChallenge(challenge, AuthIdentityType.PHONE, now))
        assertFalse(
            AuthResponseValidator.validChallenge(
                challenge.copy(maskedTarget = "+8613800138000"),
                AuthIdentityType.PHONE,
                now,
            ),
        )
        assertFalse(AuthResponseValidator.validChallenge(challenge, AuthIdentityType.EMAIL, now))
        assertFalse(
            AuthResponseValidator.validChallenge(
                challenge.copy(expiresAt = now.plusSeconds(631).toString()),
                AuthIdentityType.PHONE,
                now,
            ),
        )
    }

    @Test
    fun `OAuth state validator enforces the published provider purpose matrix`() {
        val response = OAuthStateResponse(
            provider = AuthIdentityType.WECHAT,
            purpose = OAuthPurpose.LOGIN,
            state = "s".repeat(43),
            expiresAt = now.plusSeconds(300).toString(),
        )

        assertTrue(
            AuthResponseValidator.validOAuthState(
                response,
                AuthIdentityType.WECHAT,
                OAuthPurpose.LOGIN,
                now,
            ),
        )
        assertTrue(
            AuthResponseValidator.validOAuthState(
                response.copy(purpose = OAuthPurpose.BIND),
                AuthIdentityType.WECHAT,
                OAuthPurpose.BIND,
                now,
            ),
        )
        assertTrue(
            AuthResponseValidator.validOAuthState(
                response.copy(provider = AuthIdentityType.QQ, purpose = OAuthPurpose.BIND),
                AuthIdentityType.QQ,
                OAuthPurpose.BIND,
                now,
            ),
        )
    }

    @Test
    fun `identity list preserves primary and unbind policy`() {
        val phone = AuthIdentityBinding(
            bindingId = "11111111-1111-4111-8111-111111111111",
            type = AuthIdentityType.PHONE,
            maskedValue = "+86138****1234",
            boundAt = now.toString(),
            primary = true,
            canUnbind = false,
        )
        val email = AuthIdentityBinding(
            bindingId = "22222222-2222-4222-8222-222222222222",
            type = AuthIdentityType.EMAIL,
            maskedValue = "a***@example.com",
            boundAt = now.toString(),
            primary = false,
            canUnbind = true,
        )
        assertTrue(AuthResponseValidator.validIdentities(AuthIdentityBindingsResponse(listOf(phone, email))))
        assertFalse(
            AuthResponseValidator.validIdentities(
                AuthIdentityBindingsResponse(listOf(phone, email.copy(type = AuthIdentityType.WECHAT))),
            ),
        )
        assertTrue(
            AuthResponseValidator.validIdentities(
                AuthIdentityBindingsResponse(
                    listOf(
                        phone,
                        email.copy(
                            type = AuthIdentityType.QQ,
                            maskedValue = "QQ 账号",
                            canUnbind = true,
                        ),
                    ),
                ),
            ),
        )
    }

    @Test
    fun `session list accepts mixed supported platforms and requires exactly one current session`() {
        val session = AuthSessionSummary(
            sessionId = "11111111-1111-4111-8111-111111111111",
            deviceLabel = "Android 设备",
            platform = "ANDROID",
            current = true,
            createdAt = now.toString(),
            lastActiveAt = now.plusSeconds(1).toString(),
            expiresAt = now.plusSeconds(3600).toString(),
        )
        assertTrue(AuthResponseValidator.validSessions(AuthSessionsResponse(listOf(session))))
        val miniprogram = session.copy(
            sessionId = "22222222-2222-4222-8222-222222222222",
            platform = "MINIPROGRAM",
            deviceLabel = "微信小程序",
            current = false,
        )
        assertTrue(AuthResponseValidator.validSessions(AuthSessionsResponse(listOf(session, miniprogram))))
        assertFalse(
            AuthResponseValidator.validSessions(
                AuthSessionsResponse(listOf(session, miniprogram.copy(current = true))),
            ),
        )
        assertFalse(
            AuthResponseValidator.validSessions(
                AuthSessionsResponse(listOf(session, miniprogram.copy(platform = "IOS"))),
            ),
        )
        assertFalse(
            AuthResponseValidator.validSessions(
                AuthSessionsResponse(listOf(session, miniprogram.copy(sessionId = session.sessionId))),
            ),
        )
        assertFalse(
            AuthResponseValidator.validSessions(
                AuthSessionsResponse(listOf(session.copy(current = false))),
            ),
        )
        assertFalse(
            AuthResponseValidator.validSessions(
                AuthSessionsResponse(listOf(session.copy(platform = "UNKNOWN"))),
            ),
        )
    }

    private fun validTokens(): AuthTokenResponse = AuthTokenResponse(
        userId = "11111111-1111-4111-8111-111111111111",
        sessionId = "22222222-2222-4222-8222-222222222222",
        tokenType = "Bearer",
        accessToken = "a".repeat(43),
        accessTokenExpiresAt = now.plusSeconds(900).toString(),
        refreshToken = "b".repeat(43),
        refreshTokenExpiresAt = now.plusSeconds(30 * 24 * 60 * 60L).toString(),
    )
}
