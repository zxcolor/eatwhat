package com.chishenme.app.auth.wechat

import com.chishenme.app.data.remote.OAuthPurpose
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant

internal enum class WechatOAuthFailure {
    PRIVACY_REQUIRED,
    CLIENT_NOT_CONFIGURED,
    UNSUPPORTED_PURPOSE,
    WECHAT_NOT_INSTALLED,
    SDK_REGISTRATION_FAILED,
    AUTHORIZATION_LAUNCH_FAILED,
    BUSY,
    INVALID_SERVER_STATE,
    STATE_EXPIRED,
    NO_PENDING_AUTHORIZATION,
    STATE_MISMATCH,
    INVALID_CALLBACK,
    USER_CANCELLED,
    AUTHORIZATION_DENIED,
}

internal sealed interface WechatCoordinatorPrepareResult {
    data object Ready : WechatCoordinatorPrepareResult
    data class Rejected(val failure: WechatOAuthFailure) : WechatCoordinatorPrepareResult
}

internal sealed interface WechatCoordinatorConsumeResult {
    class Accepted(
        val purpose: OAuthPurpose,
        val state: String,
        val authorizationCode: String,
    ) : WechatCoordinatorConsumeResult {
        override fun toString(): String = "WechatCoordinatorConsumeResult.Accepted(purpose=$purpose)"
    }

    data class Rejected(
        val purpose: OAuthPurpose?,
        val failure: WechatOAuthFailure,
    ) : WechatCoordinatorConsumeResult
}

/**
 * Process-memory CSRF coordinator for WeChat OAuth.
 *
 * Nothing is written to SavedStateHandle, DataStore, disk, logs, or intents.
 * Consequently a process restart deliberately loses the pending state and the
 * callback must fail rather than attempting to reconstruct trust.
 */
internal class WechatOAuthCoordinator(
    private val now: () -> Instant = Instant::now,
) {
    private var pending: PendingAuthorization? = null

    @Synchronized
    fun prepare(
        purpose: OAuthPurpose,
        state: String,
        expiresAt: Instant,
    ): WechatCoordinatorPrepareResult {
        if (purpose !in setOf(OAuthPurpose.LOGIN, OAuthPurpose.BIND)) {
            return WechatCoordinatorPrepareResult.Rejected(
                WechatOAuthFailure.UNSUPPORTED_PURPOSE,
            )
        }
        val currentTime = now()
        pending?.let { current ->
            if (current.expiresAt.isAfter(currentTime)) {
                return WechatCoordinatorPrepareResult.Rejected(WechatOAuthFailure.BUSY)
            }
            pending = null
        }
        if (!state.matches(OPAQUE_STATE)) {
            return WechatCoordinatorPrepareResult.Rejected(WechatOAuthFailure.INVALID_SERVER_STATE)
        }
        if (!expiresAt.isAfter(currentTime)) {
            return WechatCoordinatorPrepareResult.Rejected(WechatOAuthFailure.STATE_EXPIRED)
        }
        if (expiresAt.isAfter(currentTime.plusSeconds(MAX_STATE_LIFETIME_SECONDS))) {
            return WechatCoordinatorPrepareResult.Rejected(WechatOAuthFailure.INVALID_SERVER_STATE)
        }
        pending = PendingAuthorization(purpose, state, expiresAt)
        return WechatCoordinatorPrepareResult.Ready
    }

    /** Atomically consumes the only pending authorization, even on rejection. */
    @Synchronized
    fun consume(
        callbackState: String?,
        authorizationCode: String?,
    ): WechatCoordinatorConsumeResult {
        val current = pending.also { pending = null }
            ?: return WechatCoordinatorConsumeResult.Rejected(
                purpose = null,
                failure = WechatOAuthFailure.NO_PENDING_AUTHORIZATION,
            )
        if (!current.expiresAt.isAfter(now())) {
            return WechatCoordinatorConsumeResult.Rejected(
                purpose = current.purpose,
                failure = WechatOAuthFailure.STATE_EXPIRED,
            )
        }
        if (callbackState == null || !constantTimeEquals(current.state, callbackState)) {
            return WechatCoordinatorConsumeResult.Rejected(
                purpose = current.purpose,
                failure = WechatOAuthFailure.STATE_MISMATCH,
            )
        }
        if (
            authorizationCode == null ||
            authorizationCode.length !in 8..MAX_AUTHORIZATION_CODE_LENGTH ||
            !authorizationCode.matches(SAFE_AUTHORIZATION_CODE)
        ) {
            return WechatCoordinatorConsumeResult.Rejected(
                purpose = current.purpose,
                failure = WechatOAuthFailure.INVALID_CALLBACK,
            )
        }
        return WechatCoordinatorConsumeResult.Accepted(
            purpose = current.purpose,
            state = current.state,
            authorizationCode = authorizationCode,
        )
    }

    @Synchronized
    fun cancel(): OAuthPurpose? = pending?.purpose.also { pending = null }

    @Synchronized
    fun pendingPurpose(): OAuthPurpose? {
        val current = pending ?: return null
        if (!current.expiresAt.isAfter(now())) {
            pending = null
            return null
        }
        return current.purpose
    }

    private fun constantTimeEquals(expected: String, actual: String): Boolean =
        MessageDigest.isEqual(
            expected.toByteArray(StandardCharsets.US_ASCII),
            actual.toByteArray(StandardCharsets.US_ASCII),
        )

    private data class PendingAuthorization(
        val purpose: OAuthPurpose,
        val state: String,
        val expiresAt: Instant,
    )

    private companion object {
        const val MAX_STATE_LIFETIME_SECONDS = 15 * 60L + 30L
        const val MAX_AUTHORIZATION_CODE_LENGTH = 2_048
        val OPAQUE_STATE = Regex("^[A-Za-z0-9_-]{43}$")
        val SAFE_AUTHORIZATION_CODE = Regex("^[A-Za-z0-9._~+/=-]+$")
    }
}
