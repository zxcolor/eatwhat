package com.chishenme.app.auth.wechat

import android.content.Intent
import com.chishenme.app.data.remote.OAuthPurpose
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WechatOAuthManagerTest {
    private val now = Instant.parse("2026-08-21T04:00:00Z")
    private val state = "s".repeat(43)

    @Test
    fun `constructing manager never creates or registers SDK`() {
        val factory = FakeFactory(configured = true)

        WechatOAuthManager(
            consentGate = WechatConsentGate { true },
            sessionFactory = factory,
            coordinator = WechatOAuthCoordinator { now },
        )

        assertEquals(0, factory.createCount)
        assertEquals(0, factory.session.registerCount)
        assertEquals(0, factory.session.sendCount)
    }

    @Test
    fun `privacy refusal and missing AppID fail before SDK creation`() = runTest {
        val refusedFactory = FakeFactory(configured = true)
        val refused = manager(consent = false, factory = refusedFactory).beginAuthorization(
            OAuthPurpose.LOGIN,
            state,
            now.plusSeconds(300),
        )
        assertEquals(
            WechatOAuthFailure.PRIVACY_REQUIRED,
            (refused as WechatOAuthStartResult.Failed).reason,
        )
        assertEquals(0, refusedFactory.createCount)

        val unconfiguredFactory = FakeFactory(configured = false)
        val unconfigured = manager(consent = true, factory = unconfiguredFactory).beginAuthorization(
            OAuthPurpose.LOGIN,
            state,
            now.plusSeconds(300),
        )
        assertEquals(
            WechatOAuthFailure.CLIENT_NOT_CONFIGURED,
            (unconfigured as WechatOAuthStartResult.Failed).reason,
        )
        assertEquals(0, unconfiguredFactory.createCount)
    }

    @Test
    fun `cancelling the consent read propagates cancellation without creating SDK`() = runTest {
        val factory = FakeFactory(configured = true)
        val cancellation = CancellationException("authorization job cancelled")
        val manager = WechatOAuthManager(
            consentGate = WechatConsentGate { throw cancellation },
            sessionFactory = factory,
            coordinator = WechatOAuthCoordinator { now },
        )

        try {
            manager.beginAuthorization(OAuthPurpose.LOGIN, state, now.plusSeconds(300))
            fail("CancellationException must propagate")
        } catch (error: CancellationException) {
            assertTrue(error === cancellation)
        }
        assertEquals(0, factory.createCount)
    }

    @Test
    fun `privacy withdrawal racing a stale consent read prevents SDK creation`() = runTest {
        val consentReadStarted = CompletableDeferred<Unit>()
        val finishConsentRead = CompletableDeferred<Boolean>()
        val factory = FakeFactory(configured = true)
        val manager = WechatOAuthManager(
            consentGate = WechatConsentGate {
                consentReadStarted.complete(Unit)
                finishConsentRead.await()
            },
            sessionFactory = factory,
            coordinator = WechatOAuthCoordinator { now },
        )
        val pending = async {
            manager.beginAuthorization(OAuthPurpose.LOGIN, state, now.plusSeconds(300))
        }

        consentReadStarted.await()
        manager.revokePrivacyConsent()
        finishConsentRead.complete(true)

        val failed = pending.await() as WechatOAuthStartResult.Failed
        assertEquals(WechatOAuthFailure.PRIVACY_REQUIRED, failed.reason)
        assertEquals(0, factory.createCount)
    }

    @Test
    fun `withdrawal latch blocks stale accepted storage until explicit persisted consent`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)

        manager.revokePrivacyConsent()
        val blocked = manager.beginAuthorization(
            OAuthPurpose.LOGIN,
            state,
            now.plusSeconds(300),
        ) as WechatOAuthStartResult.Failed

        assertEquals(WechatOAuthFailure.PRIVACY_REQUIRED, blocked.reason)
        assertEquals(0, factory.createCount)

        manager.allowPrivacyConsent()
        assertEquals(
            WechatOAuthStartResult.Started,
            manager.beginAuthorization(OAuthPurpose.LOGIN, state, now.plusSeconds(300)),
        )
        assertEquals(1, factory.createCount)
    }

    @Test
    fun `explicit consented launch registers and sends exactly once`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)

        assertEquals(
            WechatOAuthStartResult.Started,
            manager.beginAuthorization(OAuthPurpose.LOGIN, state, now.plusSeconds(300)),
        )

        assertEquals(1, factory.createCount)
        assertEquals(1, factory.session.registerCount)
        assertEquals(1, factory.session.installedCheckCount)
        assertEquals(1, factory.session.sendCount)
        assertEquals(state, factory.session.sentState)
    }

    @Test
    fun `bind fails before SDK creation`() = runTest {
        val factory = FakeFactory(configured = true)
        val result = manager(consent = true, factory = factory).beginAuthorization(
            OAuthPurpose.BIND,
            state,
            now.plusSeconds(300),
        ) as WechatOAuthStartResult.Failed

        assertEquals(WechatOAuthFailure.UNSUPPORTED_PURPOSE, result.reason)
        assertEquals(0, factory.createCount)
        assertEquals(0, factory.session.registerCount)
    }

    @Test
    fun `mismatched callback emits only safe failure and detaches`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(OAuthPurpose.LOGIN, state, now.plusSeconds(300))
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        val attackerState = "x".repeat(43)
        val privateCode = "authorization-code-private"

        manager.acceptSdkCallback(WechatSdkCallback.Authorized(attackerState, privateCode))
        val failure = event.await() as WechatOAuthEvent.Failed

        assertEquals(WechatOAuthFailure.STATE_MISMATCH, failure.reason)
        assertFalse(failure.toString().contains(attackerState))
        assertFalse(failure.toString().contains(privateCode))
        assertEquals(1, factory.session.detachCount)
    }

    @Test
    fun `cancelled callback contains no provider error material`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(OAuthPurpose.REGISTER, state, now.plusSeconds(300))
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }

        manager.acceptSdkCallback(WechatSdkCallback.Cancelled)
        val failure = event.await() as WechatOAuthEvent.Failed

        assertEquals(OAuthPurpose.REGISTER, failure.purpose)
        assertEquals(WechatOAuthFailure.USER_CANCELLED, failure.reason)
        assertFalse(failure.toString().contains(state))
    }

    @Test
    fun `successful callback debug text omits state and code`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(OAuthPurpose.LOGIN, state, now.plusSeconds(300))
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        val privateCode = "authorization-code-private"

        manager.acceptSdkCallback(WechatSdkCallback.Authorized(state, privateCode))
        val authorized = event.await() as WechatOAuthEvent.Authorized

        assertEquals(OAuthPurpose.LOGIN, authorized.purpose)
        assertFalse(authorized.toString().contains(state))
        assertFalse(authorized.toString().contains(privateCode))
        val consumed = authorized.consumeProof { proofState, proofCode ->
            assertEquals(state, proofState)
            assertEquals(privateCode, proofCode)
            "sent-to-backend"
        }
        assertEquals("sent-to-backend", consumed)
        assertEquals(null, authorized.consumeProof { _, _ -> "replayed" })
    }

    @Test
    fun `privacy withdrawal emits safe failure and is idempotent`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(OAuthPurpose.REGISTER, state, now.plusSeconds(300))
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }

        manager.revokePrivacyConsent()
        val failure = event.await() as WechatOAuthEvent.Failed

        assertEquals(OAuthPurpose.REGISTER, failure.purpose)
        assertEquals(WechatOAuthFailure.PRIVACY_REQUIRED, failure.reason)
        assertFalse(failure.toString().contains(state))
        assertEquals(1, factory.session.detachCount)

        manager.revokePrivacyConsent()
        assertEquals(1, factory.session.detachCount)
        assertEquals(1, factory.createCount)
    }

    @Test
    fun `callback captured by old SDK session cannot consume or close new attempt`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(OAuthPurpose.LOGIN, state, now.plusSeconds(300))
        assertTrue(manager.handleCallbackIntent(Intent()))
        val firstSession = factory.sessions.single()
        val oldCallback = checkNotNull(firstSession.callback)

        manager.revokePrivacyConsent()
        manager.allowPrivacyConsent()
        val nextState = "n".repeat(43)
        manager.beginAuthorization(OAuthPurpose.REGISTER, nextState, now.plusSeconds(300))
        assertTrue(manager.handleCallbackIntent(Intent()))
        val secondSession = factory.sessions.last()

        oldCallback(WechatSdkCallback.Authorized(state, "old-private-code"))
        assertEquals(0, secondSession.detachCount)

        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        checkNotNull(secondSession.callback)(
            WechatSdkCallback.Authorized(nextState, "new-private-code"),
        )
        val authorized = event.await() as WechatOAuthEvent.Authorized

        assertEquals(OAuthPurpose.REGISTER, authorized.purpose)
        assertEquals(1, secondSession.detachCount)
    }

    private fun manager(
        consent: Boolean,
        factory: FakeFactory,
    ): WechatOAuthManager = WechatOAuthManager(
        consentGate = WechatConsentGate { consent },
        sessionFactory = factory,
        coordinator = WechatOAuthCoordinator { now },
    )

    private class FakeFactory(
        private val configured: Boolean,
    ) : WechatSdkSessionFactory {
        private val initialSession = FakeSession()
        val sessions = mutableListOf<FakeSession>()
        val session: FakeSession
            get() = sessions.lastOrNull() ?: initialSession
        var createCount = 0
        override val isConfigured: Boolean
            get() = configured

        override fun create(): WechatSdkSession {
            val created = if (createCount == 0) initialSession else FakeSession()
            createCount += 1
            sessions += created
            return created
        }
    }

    private class FakeSession : WechatSdkSession {
        var registerCount = 0
        var installedCheckCount = 0
        var sendCount = 0
        var detachCount = 0
        var sentState: String? = null
        var callback: ((WechatSdkCallback) -> Unit)? = null

        override fun registerApp(): Boolean {
            registerCount += 1
            return true
        }

        override fun isWechatInstalled(): Boolean {
            installedCheckCount += 1
            return true
        }

        override fun sendAuthorization(state: String): Boolean {
            sendCount += 1
            sentState = state
            return true
        }

        override fun handleIntent(
            intent: Intent,
            onCallback: (WechatSdkCallback) -> Unit,
        ): Boolean {
            callback = onCallback
            return true
        }

        override fun detach() {
            detachCount += 1
        }
    }
}
