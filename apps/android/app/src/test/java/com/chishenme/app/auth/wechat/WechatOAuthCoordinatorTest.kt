package com.chishenme.app.auth.wechat

import com.chishenme.app.data.remote.OAuthPurpose
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WechatOAuthCoordinatorTest {
    private var currentTime = Instant.parse("2026-08-21T04:00:00Z")
    private val coordinator = WechatOAuthCoordinator { currentTime }

    @Test
    fun `state is purpose-bound short-lived and consumed once`() {
        val state = "a".repeat(43)
        assertEquals(
            WechatCoordinatorPrepareResult.Ready,
            coordinator.prepare(OAuthPurpose.LOGIN, state, currentTime.plusSeconds(300)),
        )

        val accepted = coordinator.consume(state, "authorization-code-123")
        assertTrue(accepted is WechatCoordinatorConsumeResult.Accepted)
        assertEquals(OAuthPurpose.LOGIN, (accepted as WechatCoordinatorConsumeResult.Accepted).purpose)

        val replay = coordinator.consume(state, "authorization-code-123")
        assertEquals(
            WechatOAuthFailure.NO_PENDING_AUTHORIZATION,
            (replay as WechatCoordinatorConsumeResult.Rejected).failure,
        )
    }

    @Test
    fun `mismatched state consumes attempt without reflecting secrets`() {
        val expected = "b".repeat(43)
        val attackerState = "c".repeat(43)
        val code = "authorization-code-private"
        coordinator.prepare(OAuthPurpose.REGISTER, expected, currentTime.plusSeconds(300))

        val rejected = coordinator.consume(attackerState, code)
            as WechatCoordinatorConsumeResult.Rejected

        assertEquals(WechatOAuthFailure.STATE_MISMATCH, rejected.failure)
        assertFalse(rejected.toString().contains(attackerState))
        assertFalse(rejected.toString().contains(code))
        assertEquals(null, coordinator.pendingPurpose())
    }

    @Test
    fun `bind is unsupported and does not occupy coordinator`() {
        val state = "f".repeat(43)

        val rejected = coordinator.prepare(
            OAuthPurpose.BIND,
            state,
            currentTime.plusSeconds(300),
        ) as WechatCoordinatorPrepareResult.Rejected

        assertEquals(WechatOAuthFailure.UNSUPPORTED_PURPOSE, rejected.failure)
        assertEquals(null, coordinator.pendingPurpose())
        assertEquals(
            WechatCoordinatorPrepareResult.Ready,
            coordinator.prepare(OAuthPurpose.LOGIN, state, currentTime.plusSeconds(300)),
        )
    }

    @Test
    fun `expired and implausibly long server states fail closed`() {
        val state = "d".repeat(43)
        assertEquals(
            WechatOAuthFailure.STATE_EXPIRED,
            (coordinator.prepare(OAuthPurpose.LOGIN, state, currentTime) as
                WechatCoordinatorPrepareResult.Rejected).failure,
        )
        assertEquals(
            WechatOAuthFailure.INVALID_SERVER_STATE,
            (coordinator.prepare(
                OAuthPurpose.LOGIN,
                state,
                currentTime.plusSeconds(16 * 60L),
            ) as WechatCoordinatorPrepareResult.Rejected).failure,
        )
    }

    @Test
    fun `new coordinator models process restart and rejects old callback`() {
        val state = "e".repeat(43)
        coordinator.prepare(OAuthPurpose.REGISTER, state, currentTime.plusSeconds(300))

        val restartedProcessCoordinator = WechatOAuthCoordinator { currentTime }
        val rejected = restartedProcessCoordinator.consume(state, "authorization-code-123")
            as WechatCoordinatorConsumeResult.Rejected

        assertEquals(WechatOAuthFailure.NO_PENDING_AUTHORIZATION, rejected.failure)
        assertTrue(coordinator.pendingPurpose() == OAuthPurpose.REGISTER)
    }
}
