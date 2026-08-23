package com.chishenme.app.data.remote

import java.time.Instant
import java.util.UUID

internal object AuthResponseValidator {
    private val opaqueToken = Regex("^[A-Za-z0-9_-]{43}$")
    private val phoneMask = Regex("^\\+861\\d{2}\\*{4}\\d{4}$")
    private val emailMask = Regex("^[^@\\s]*\\*+[^@\\s]*@[A-Za-z0-9.-]{1,190}$")

    fun validTokens(
        response: AuthTokenResponse,
        now: Instant,
        expectedUserId: String? = null,
        expectedSessionId: String? = null,
    ): Boolean {
        val accessExpiry = response.accessTokenExpiresAt.asInstant() ?: return false
        val refreshExpiry = response.refreshTokenExpiresAt.asInstant() ?: return false
        return response.userId.isCanonicalUuid() &&
            response.sessionId.isCanonicalUuid() &&
            (expectedUserId == null || response.userId == expectedUserId) &&
            (expectedSessionId == null || response.sessionId == expectedSessionId) &&
            response.tokenType == "Bearer" &&
            response.accessToken.matches(opaqueToken) &&
            response.refreshToken.matches(opaqueToken) &&
            response.accessToken != response.refreshToken &&
            accessExpiry.isAfter(now) &&
            accessExpiry <= now.plusSeconds(30 * 60L + CLOCK_SKEW_SECONDS) &&
            refreshExpiry.isAfter(accessExpiry) &&
            refreshExpiry <= now.plusSeconds(30 * 24 * 60 * 60L + CLOCK_SKEW_SECONDS)
    }

    fun validChallenge(
        challenge: AuthCodeChallenge,
        expectedType: AuthIdentityType,
        now: Instant,
    ): Boolean {
        val expiry = challenge.expiresAt.asInstant() ?: return false
        val resend = challenge.resendAvailableAt.asInstant() ?: return false
        val validMask = when (expectedType) {
            AuthIdentityType.PHONE -> challenge.maskedTarget.matches(phoneMask)
            AuthIdentityType.EMAIL -> challenge.maskedTarget.matches(emailMask)
            else -> false
        }
        return challenge.challengeId.isCanonicalUuid() &&
            challenge.targetType == expectedType &&
            validMask &&
            expiry.isAfter(now) &&
            expiry <= now.plusSeconds(MAX_OTP_TTL_SECONDS + CLOCK_SKEW_SECONDS) &&
            resend.isAfter(now.minusSeconds(CLOCK_SKEW_SECONDS)) &&
            resend <= expiry
    }

    fun validOAuthState(
        response: OAuthStateResponse,
        provider: AuthIdentityType,
        purpose: OAuthPurpose,
        now: Instant,
    ): Boolean =
        when (provider) {
            AuthIdentityType.WECHAT -> purpose in setOf(OAuthPurpose.REGISTER, OAuthPurpose.LOGIN)
            AuthIdentityType.QQ -> purpose in setOf(OAuthPurpose.LOGIN, OAuthPurpose.BIND)
            else -> false
        } &&
            response.provider == provider &&
            response.purpose == purpose &&
            response.state.matches(opaqueToken) &&
            (response.expiresAt.asInstant()?.let { expiry ->
                expiry.isAfter(now) && expiry <= now.plusSeconds(15 * 60L + CLOCK_SKEW_SECONDS)
            } == true)

    fun validIdentities(response: AuthIdentityBindingsResponse): Boolean =
        response.items.size <= 8 &&
            response.items.map { it.bindingId }.distinct().size == response.items.size &&
            response.items.count { it.primary } == 1 &&
            response.items.all(::validIdentity)

    fun validIdentity(binding: AuthIdentityBinding): Boolean {
        val validMask = when (binding.type) {
            AuthIdentityType.PHONE -> binding.maskedValue.matches(phoneMask)
            AuthIdentityType.EMAIL -> binding.maskedValue.matches(emailMask)
            AuthIdentityType.WECHAT -> binding.maskedValue == "微信账号"
            AuthIdentityType.QQ -> binding.maskedValue == "QQ 账号"
        }
        return binding.bindingId.isCanonicalUuid() &&
            validMask &&
            binding.boundAt.asInstant() != null &&
            (!binding.primary || binding.type == AuthIdentityType.PHONE) &&
            // The API permits secondary email and QQ identities to be removed.
            // Phone remains primary and WeChat remains a required registration identity.
            (!binding.canUnbind || binding.type in setOf(AuthIdentityType.EMAIL, AuthIdentityType.QQ))
    }

    fun validSessions(response: AuthSessionsResponse): Boolean =
        response.items.isNotEmpty() &&
            response.items.size <= 50 &&
            response.items.map { it.sessionId }.distinct().size == response.items.size &&
            response.items.count { it.current } == 1 &&
            response.items.all { session ->
                val created = session.createdAt.asInstant()
                val active = session.lastActiveAt.asInstant()
                val expires = session.expiresAt.asInstant()
                session.sessionId.isCanonicalUuid() &&
                    session.deviceLabel.isNotBlank() &&
                    session.deviceLabel.length <= 80 &&
                    session.platform == "ANDROID" &&
                    created != null && active != null && expires != null &&
                    !active.isBefore(created) && expires.isAfter(created)
            }

    internal fun String.isCanonicalUuid(): Boolean = runCatching {
        UUID.fromString(this).toString() == lowercase()
    }.getOrDefault(false)

    internal fun String.asInstant(): Instant? = runCatching(Instant::parse).getOrNull()

    private const val CLOCK_SKEW_SECONDS = 30L
    private const val MAX_OTP_TTL_SECONDS = 10 * 60L
}
