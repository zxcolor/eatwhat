package com.chishenme.app.auth.qq

import com.chishenme.app.data.remote.OAuthPurpose
import java.time.Instant

internal enum class QqOAuthFailure {
    PRIVACY_REQUIRED,
    CLIENT_NOT_CONFIGURED,
    HOST_ACTIVITY_UNAVAILABLE,
    UNSUPPORTED_PURPOSE,
    BUSY,
    INVALID_SERVER_STATE,
    STATE_EXPIRED,
    SDK_INITIALIZATION_FAILED,
    SDK_ERROR,
    AUTHORIZATION_LAUNCH_FAILED,
    NO_PENDING_AUTHORIZATION,
    INVALID_CALLBACK,
    USER_CANCELLED,
    AUTHORIZATION_DENIED,
}

internal sealed interface QqCoordinatorPrepareResult {
    data object Ready : QqCoordinatorPrepareResult
    data class Rejected(val failure: QqOAuthFailure) : QqCoordinatorPrepareResult
}

internal sealed interface QqCoordinatorConsumeResult {
    class Accepted(
        val purpose: OAuthPurpose,
        val state: String,
        val accessToken: String,
    ) : QqCoordinatorConsumeResult {
        override fun toString(): String = "QqCoordinatorConsumeResult.Accepted(purpose=$purpose)"
    }

    data class Rejected(
        val purpose: OAuthPurpose?,
        val failure: QqOAuthFailure,
    ) : QqCoordinatorConsumeResult
}

/**
 * Holds the backend-issued OAuth state only for the current app process.
 *
 * QQ OpenSDK's Android login callback does not echo an application state
 * parameter. The state is therefore purpose-bound to exactly one explicit SDK
 * launch and atomically consumed with its callback. A process restart, expiry,
 * cancellation, or replay loses the proof and fails closed.
 */
internal class QqOAuthCoordinator(
    private val now: () -> Instant = Instant::now,
) {
    private var pending: PendingAuthorization? = null

    @Synchronized
    fun prepare(
        purpose: OAuthPurpose,
        state: String,
        expiresAt: Instant,
    ): QqCoordinatorPrepareResult {
        if (purpose !in setOf(OAuthPurpose.LOGIN, OAuthPurpose.BIND)) {
            return QqCoordinatorPrepareResult.Rejected(QqOAuthFailure.UNSUPPORTED_PURPOSE)
        }
        val currentTime = now()
        pending?.let { current ->
            if (current.expiresAt.isAfter(currentTime)) {
                return QqCoordinatorPrepareResult.Rejected(QqOAuthFailure.BUSY)
            }
            pending = null
        }
        if (!state.matches(OPAQUE_STATE)) {
            return QqCoordinatorPrepareResult.Rejected(QqOAuthFailure.INVALID_SERVER_STATE)
        }
        if (!expiresAt.isAfter(currentTime)) {
            return QqCoordinatorPrepareResult.Rejected(QqOAuthFailure.STATE_EXPIRED)
        }
        if (expiresAt.isAfter(currentTime.plusSeconds(MAX_STATE_LIFETIME_SECONDS))) {
            return QqCoordinatorPrepareResult.Rejected(QqOAuthFailure.INVALID_SERVER_STATE)
        }
        pending = PendingAuthorization(purpose, state, expiresAt)
        return QqCoordinatorPrepareResult.Ready
    }

    /** Atomically consumes the only pending attempt even when validation fails. */
    @Synchronized
    fun consume(accessToken: String?): QqCoordinatorConsumeResult {
        val current = pending.also { pending = null }
            ?: return QqCoordinatorConsumeResult.Rejected(
                purpose = null,
                failure = QqOAuthFailure.NO_PENDING_AUTHORIZATION,
            )
        if (!current.expiresAt.isAfter(now())) {
            return QqCoordinatorConsumeResult.Rejected(
                purpose = current.purpose,
                failure = QqOAuthFailure.STATE_EXPIRED,
            )
        }
        if (
            accessToken == null ||
            accessToken.length !in MIN_ACCESS_TOKEN_LENGTH..MAX_ACCESS_TOKEN_LENGTH ||
            !accessToken.matches(SAFE_ACCESS_TOKEN)
        ) {
            return QqCoordinatorConsumeResult.Rejected(
                purpose = current.purpose,
                failure = QqOAuthFailure.INVALID_CALLBACK,
            )
        }
        return QqCoordinatorConsumeResult.Accepted(
            purpose = current.purpose,
            state = current.state,
            accessToken = accessToken,
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

    private class PendingAuthorization(
        val purpose: OAuthPurpose,
        val state: String,
        val expiresAt: Instant,
    ) {
        override fun toString(): String = "PendingAuthorization(purpose=$purpose)"
    }

    private companion object {
        const val MAX_STATE_LIFETIME_SECONDS = 15 * 60L + 30L
        const val MIN_ACCESS_TOKEN_LENGTH = 16
        const val MAX_ACCESS_TOKEN_LENGTH = 2_048
        val OPAQUE_STATE = Regex("^[A-Za-z0-9_-]{43}$")
        val SAFE_ACCESS_TOKEN = Regex("^[A-Za-z0-9._~+/=-]+$")
    }
}
