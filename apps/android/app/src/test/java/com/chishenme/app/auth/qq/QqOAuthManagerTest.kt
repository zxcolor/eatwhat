package com.chishenme.app.auth.qq

import android.app.Activity
import android.content.Intent
import com.chishenme.app.data.remote.OAuthPurpose
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QqOAuthManagerTest {
    private val now = Instant.parse("2026-08-21T04:00:00Z")
    private val state = "s".repeat(43)
    private val token = "private-access-token-1234567890"

    @Test
    fun `construction and privacy refusal never create SDK`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = false, factory = factory)

        assertEquals(0, factory.createCount)
        val result = manager.beginAuthorization(
            host = FakeHost(),
            purpose = OAuthPurpose.LOGIN,
            state = state,
            expiresAt = now.plusSeconds(300),
        ) as QqOAuthStartResult.Failed

        assertEquals(QqOAuthFailure.PRIVACY_REQUIRED, result.reason)
        assertEquals(0, factory.createCount)
        assertEquals(0, factory.revokeCount)
    }

    @Test
    fun `missing AppID and unavailable host fail before SDK creation`() = runTest {
        val unconfigured = FakeFactory(configured = false)
        assertEquals(
            QqOAuthFailure.CLIENT_NOT_CONFIGURED,
            (manager(true, unconfigured).beginAuthorization(
                FakeHost(), OAuthPurpose.LOGIN, state, now.plusSeconds(300),
            ) as QqOAuthStartResult.Failed).reason,
        )
        assertEquals(0, unconfigured.createCount)

        val configured = FakeFactory(configured = true)
        assertEquals(
            QqOAuthFailure.HOST_ACTIVITY_UNAVAILABLE,
            (manager(true, configured).beginAuthorization(
                FakeHost(isAvailable = false), OAuthPurpose.LOGIN, state, now.plusSeconds(300),
            ) as QqOAuthStartResult.Failed).reason,
        )
        assertEquals(0, configured.createCount)
    }

    @Test
    fun `privacy withdrawal racing a stale consent read prevents SDK creation`() = runTest {
        val consentReadStarted = CompletableDeferred<Unit>()
        val finishConsentRead = CompletableDeferred<Boolean>()
        val factory = FakeFactory(configured = true)
        val manager = QqOAuthManager(
            consentGate = QqConsentGate {
                consentReadStarted.complete(Unit)
                finishConsentRead.await()
            },
            sessionFactory = factory,
            coordinator = QqOAuthCoordinator { now },
        )
        val pending = async {
            manager.beginAuthorization(
                FakeHost(), OAuthPurpose.LOGIN, state, now.plusSeconds(300),
            )
        }

        consentReadStarted.await()
        manager.revokePrivacyConsent()
        finishConsentRead.complete(true)

        val failed = pending.await() as QqOAuthStartResult.Failed
        assertEquals(QqOAuthFailure.PRIVACY_REQUIRED, failed.reason)
        assertEquals(0, factory.createCount)
        assertEquals(1, factory.revokeCount)
    }

    @Test
    fun `withdrawal latch blocks stale accepted storage until explicit persisted consent`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)

        manager.revokePrivacyConsent()
        val blocked = manager.beginAuthorization(
            FakeHost(), OAuthPurpose.LOGIN, state, now.plusSeconds(300),
        ) as QqOAuthStartResult.Failed

        assertEquals(QqOAuthFailure.PRIVACY_REQUIRED, blocked.reason)
        assertEquals(0, factory.createCount)

        manager.allowPrivacyConsent()
        assertEquals(
            QqOAuthStartResult.Started,
            manager.beginAuthorization(
                FakeHost(), OAuthPurpose.LOGIN, state, now.plusSeconds(300),
            ),
        )
        assertEquals(1, factory.createCount)
    }

    @Test
    fun `consented explicit launch creates once and callback proof is one shot`() = runTest {
        val factory = FakeFactory(configured = true)
        val host = FakeHost()
        val manager = manager(consent = true, factory = factory)

        assertEquals(
            QqOAuthStartResult.Started,
            manager.beginAuthorization(host, OAuthPurpose.LOGIN, state, now.plusSeconds(300)),
        )
        assertEquals(1, factory.createCount)
        assertEquals(1, host.launchCount)

        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        factory.callback?.invoke(QqSdkCallback.Authorized(token))
        val authorized = event.await() as QqOAuthEvent.Authorized

        assertFalse(authorized.toString().contains(state))
        assertFalse(authorized.toString().contains(token))
        val consumed = authorized.consumeProof { proofState, proofToken ->
            assertEquals(state, proofState)
            assertEquals(token, proofToken)
            "sent-to-backend"
        }
        assertEquals("sent-to-backend", consumed)
        assertNull(authorized.consumeProof { _, _ -> "replayed" })
        assertEquals(1, factory.session.clearCount)
    }

    @Test
    fun `provider cancellation is safe`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(FakeHost(), OAuthPurpose.BIND, state, now.plusSeconds(300))
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }

        factory.callback?.invoke(QqSdkCallback.Cancelled)
        val failed = event.await() as QqOAuthEvent.Failed

        assertEquals(QqOAuthFailure.USER_CANCELLED, failed.reason)
        assertFalse(failed.toString().contains(state))
        assertEquals(1, factory.session.clearCount)
    }

    @Test
    fun `privacy withdrawal clears and revokes with safe failure event`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(FakeHost(), OAuthPurpose.BIND, state, now.plusSeconds(300))
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }

        manager.revokePrivacyConsent()
        val failed = event.await() as QqOAuthEvent.Failed

        assertEquals(OAuthPurpose.BIND, failed.purpose)
        assertEquals(QqOAuthFailure.PRIVACY_REQUIRED, failed.reason)
        assertFalse(failed.toString().contains(state))
        assertEquals(1, factory.revokeCount)
        assertEquals(1, factory.session.clearCount)
    }

    @Test
    fun `callback captured by old SDK session cannot consume or clear new attempt`() = runTest {
        val factory = FakeFactory(configured = true)
        val manager = manager(consent = true, factory = factory)
        manager.beginAuthorization(
            FakeHost(), OAuthPurpose.LOGIN, state, now.plusSeconds(300),
        )
        val firstSession = factory.sessions.single()
        val oldCallback = factory.callbacks.single()

        manager.revokePrivacyConsent()
        manager.allowPrivacyConsent()
        val nextState = "n".repeat(43)
        manager.beginAuthorization(
            FakeHost(), OAuthPurpose.BIND, nextState, now.plusSeconds(300),
        )
        val secondSession = factory.sessions.last()

        oldCallback(QqSdkCallback.Authorized(token))
        assertEquals(0, secondSession.clearCount)

        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        factory.callbacks.last()(QqSdkCallback.Authorized(token))
        val authorized = event.await() as QqOAuthEvent.Authorized
        val consumedState = authorized.consumeProof { proofState, _ -> proofState }

        assertEquals(OAuthPurpose.BIND, authorized.purpose)
        assertEquals(nextState, consumedState)
        assertEquals(1, firstSession.clearCount)
        assertEquals(1, secondSession.clearCount)
    }

    @Test
    fun `SDK callback DTO debug text never exposes credential`() {
        val dto = QqSdkCallback.Authorized(token)

        assertFalse(dto.toString().contains(token))
        assertTrue(dto.toString().contains("Authorized"))
    }

    private fun manager(consent: Boolean, factory: FakeFactory) = QqOAuthManager(
        consentGate = QqConsentGate { consent },
        sessionFactory = factory,
        coordinator = QqOAuthCoordinator { now },
    )

    private class FakeHost(
        override val isAvailable: Boolean = true,
    ) : QqLoginHost {
        var launchCount = 0

        override fun launch(session: QqSdkSession): Boolean {
            launchCount += 1
            return true
        }
    }

    private class FakeFactory(
        private val configured: Boolean,
    ) : QqSdkSessionFactory {
        val sessions = mutableListOf<FakeSession>()
        val callbacks = mutableListOf<(QqSdkCallback) -> Unit>()
        val session: FakeSession
            get() = sessions.last()
        val callback: ((QqSdkCallback) -> Unit)?
            get() = callbacks.lastOrNull()
        var createCount = 0
        var revokeCount = 0

        override val isConfigured: Boolean
            get() = configured

        override fun create(onCallback: (QqSdkCallback) -> Unit): QqSdkSession {
            val session = FakeSession()
            createCount += 1
            callbacks += onCallback
            sessions += session
            return session
        }

        override fun revokePrivacyConsent() {
            revokeCount += 1
        }
    }

    private class FakeSession : QqSdkSession {
        var clearCount = 0

        override fun launchLogin(activity: Activity): Boolean = true

        override fun handleActivityResult(
            requestCode: Int,
            resultCode: Int,
            data: Intent?,
        ): Boolean = true

        override fun clear() {
            clearCount += 1
        }
    }
}
