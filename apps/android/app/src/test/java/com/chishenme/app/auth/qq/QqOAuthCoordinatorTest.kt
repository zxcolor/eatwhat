package com.chishenme.app.auth.qq

import com.chishenme.app.data.remote.OAuthPurpose
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QqOAuthCoordinatorTest {
    private var currentTime = Instant.parse("2026-08-21T04:00:00Z")
    private val coordinator = QqOAuthCoordinator { currentTime }

    @Test
    fun `login state is short lived purpose bound and consumed once`() {
        val state = "q".repeat(43)
        val token = "private-access-token-1234567890"
        assertEquals(
            QqCoordinatorPrepareResult.Ready,
            coordinator.prepare(OAuthPurpose.LOGIN, state, currentTime.plusSeconds(300)),
        )

        val accepted = coordinator.consume(token) as QqCoordinatorConsumeResult.Accepted
        assertEquals(OAuthPurpose.LOGIN, accepted.purpose)
        assertFalse(accepted.toString().contains(state))
        assertFalse(accepted.toString().contains(token))

        val replay = coordinator.consume(token) as QqCoordinatorConsumeResult.Rejected
        assertEquals(QqOAuthFailure.NO_PENDING_AUTHORIZATION, replay.failure)
    }

    @Test
    fun `QQ registration is impossible`() {
        val rejected = coordinator.prepare(
            OAuthPurpose.REGISTER,
            "r".repeat(43),
            currentTime.plusSeconds(300),
        ) as QqCoordinatorPrepareResult.Rejected

        assertEquals(QqOAuthFailure.UNSUPPORTED_PURPOSE, rejected.failure)
        assertNull(coordinator.pendingPurpose())
    }

    @Test
    fun `expired malformed and implausibly long state fail closed`() {
        assertEquals(
            QqOAuthFailure.INVALID_SERVER_STATE,
            (coordinator.prepare(
                OAuthPurpose.LOGIN,
                "not-a-state",
                currentTime.plusSeconds(300),
            ) as QqCoordinatorPrepareResult.Rejected).failure,
        )
        assertEquals(
            QqOAuthFailure.STATE_EXPIRED,
            (coordinator.prepare(
                OAuthPurpose.LOGIN,
                "s".repeat(43),
                currentTime,
            ) as QqCoordinatorPrepareResult.Rejected).failure,
        )
        assertEquals(
            QqOAuthFailure.INVALID_SERVER_STATE,
            (coordinator.prepare(
                OAuthPurpose.BIND,
                "t".repeat(43),
                currentTime.plusSeconds(16 * 60L),
            ) as QqCoordinatorPrepareResult.Rejected).failure,
        )
    }

    @Test
    fun `invalid token consumes attempt and leaks no secret`() {
        val state = "u".repeat(43)
        val invalidToken = "token with spaces"
        coordinator.prepare(OAuthPurpose.BIND, state, currentTime.plusSeconds(300))

        val rejected = coordinator.consume(invalidToken) as QqCoordinatorConsumeResult.Rejected

        assertEquals(QqOAuthFailure.INVALID_CALLBACK, rejected.failure)
        assertFalse(rejected.toString().contains(state))
        assertFalse(rejected.toString().contains(invalidToken))
        assertNull(coordinator.pendingPurpose())
    }

    @Test
    fun `new process cannot recover or replay old state`() {
        val state = "v".repeat(43)
        coordinator.prepare(OAuthPurpose.LOGIN, state, currentTime.plusSeconds(300))

        val restarted = QqOAuthCoordinator { currentTime }
        val rejected = restarted.consume("private-access-token-1234567890")
            as QqCoordinatorConsumeResult.Rejected

        assertEquals(QqOAuthFailure.NO_PENDING_AUTHORIZATION, rejected.failure)
        assertTrue(coordinator.pendingPurpose() == OAuthPurpose.LOGIN)
    }
}
