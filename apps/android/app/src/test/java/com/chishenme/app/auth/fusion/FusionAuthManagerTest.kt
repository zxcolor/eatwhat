package com.chishenme.app.auth.fusion

import com.chishenme.app.data.remote.FusionAuthPurpose
import com.chishenme.app.data.remote.FusionAuthTokenResponse
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import java.time.Instant
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FusionAuthManagerTest {
    @Test
    fun `construction and gate rejection never create SDK`() = runTest {
        val factory = FakeFactory(available = true)
        val manager = manager(accepted = false, factory = factory)

        assertTrue(manager.clientAvailable)
        assertEquals(0, factory.createCount)
        assertEquals(
            FusionAuthStartResult.Rejected.PRIVACY_REQUIRED,
            manager.start(
                host = FakeHost(),
                configurationGeneration = 1,
                purpose = FusionAuthPurpose.LOGIN,
                serverEnabled = true,
                token = token(),
            ),
        )
        assertEquals(0, factory.createCount)

        assertEquals(
            FusionAuthStartResult.Rejected.SERVER_DISABLED,
            manager(accepted = true, factory = factory).start(
                host = FakeHost(),
                configurationGeneration = 1,
                purpose = FusionAuthPurpose.LOGIN,
                serverEnabled = false,
                token = token(),
            ),
        )
        assertEquals(0, factory.createCount)
    }

    @Test
    fun `unavailable client and unavailable host fail before SDK creation`() = runTest {
        val unavailableFactory = FakeFactory(available = false)
        val unavailable = manager(true, unavailableFactory).start(
            FakeHost(), 1, FusionAuthPurpose.LOGIN, true, token(),
        )
        assertEquals(FusionAuthStartResult.Rejected.CLIENT_UNAVAILABLE, unavailable)
        assertEquals(0, unavailableFactory.createCount)

        val factory = FakeFactory(available = true)
        val missingHost = manager(true, factory).start(
            FakeHost(isAvailable = false), 1, FusionAuthPurpose.LOGIN, true, token(),
        )
        assertEquals(FusionAuthStartResult.Rejected.HOST_UNAVAILABLE, missingHost)
        assertEquals(0, factory.createCount)
    }

    @Test
    fun `proof token is one shot and duplicate callback is rejected`() = runTest {
        val factory = FakeFactory(available = true)
        val host = FakeHost()
        val manager = manager(true, factory)
        val started = manager.start(
            host, 7, FusionAuthPurpose.LOGIN, true, token(),
        ) as FusionAuthStartResult.Started
        assertEquals(1, factory.createCount)
        assertEquals(1, host.launchCount)

        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        val firstCompletion = FakeCompletion()
        factory.sdk.listener!!.onProof(VERIFY_TOKEN, firstCompletion)
        val proof = event.await() as FusionAuthEvent.ProofReady

        assertEquals(started.sessionId, proof.sessionId)
        assertEquals(VERIFY_TOKEN, proof.verifyToken.consume())
        assertNull(proof.verifyToken.consume())
        assertFalse(proof.toString().contains(VERIFY_TOKEN))

        val duplicate = FakeCompletion()
        factory.sdk.listener!!.onProof("d".repeat(43), duplicate)
        assertEquals(listOf(false), duplicate.results)
        manager.completeProof(proof.proofId, false)
        assertEquals(listOf(false), firstCompletion.results)
    }

    @Test
    fun `successful proof waits for template finish before destroy`() = runTest {
        val factory = FakeFactory(available = true)
        val manager = manager(true, factory)
        manager.start(FakeHost(), 9, FusionAuthPurpose.REGISTER, true, token())
        val proofEvent = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        val completion = FakeCompletion()
        factory.sdk.listener!!.onProof(VERIFY_TOKEN, completion)
        val proof = proofEvent.await() as FusionAuthEvent.ProofReady

        manager.completeProof(proof.proofId, true)

        assertEquals(listOf(true), completion.results)
        assertEquals(0, factory.sdk.cancelCount)
        assertTrue(manager.hasActiveSession)

        val finishEvent = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        factory.sdk.listener!!.onFinished()
        val completed = finishEvent.await() as FusionAuthEvent.SceneCompleted

        assertEquals(FusionAuthPurpose.REGISTER, completed.purpose)
        assertEquals(proof.sessionId, completed.sessionId)
        assertEquals(1, factory.sdk.cancelCount)
        assertFalse(manager.hasActiveSession)
    }

    @Test
    fun `configuration change invalidates proof and late callback fails closed`() = runTest {
        val factory = FakeFactory(available = true)
        val manager = manager(true, factory)
        manager.start(FakeHost(), 4, FusionAuthPurpose.LOGIN, true, token())
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        val firstCompletion = FakeCompletion()
        val listener = factory.sdk.listener!!
        listener.onProof(VERIFY_TOKEN, firstCompletion)
        val proof = event.await() as FusionAuthEvent.ProofReady

        manager.cancelForConfigurationChange(5)

        assertNull(proof.verifyToken.consume())
        assertEquals(listOf(false), firstCompletion.results)
        assertEquals(1, factory.sdk.cancelCount)
        val late = FakeCompletion()
        listener.onProof("l".repeat(43), late)
        assertEquals(listOf(false), late.results)
    }

    @Test
    fun `privacy withdrawal emits revocation and destroys active scene`() = runTest {
        val factory = FakeFactory(available = true)
        val manager = manager(true, factory)
        manager.start(FakeHost(), 3, FusionAuthPurpose.LOGIN, true, token())
        val event = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }

        manager.revokePrivacyConsent()

        assertEquals(FusionAuthEvent.PrivacyRevoked, event.await())
        assertEquals(1, factory.sdk.cancelCount)
        assertFalse(manager.hasActiveSession)
    }

    @Test
    fun `process background emits failure discards proof and rejects late callback`() = runTest {
        val factory = FakeFactory(available = true)
        val manager = manager(true, factory)
        manager.start(FakeHost(), 11, FusionAuthPurpose.LOGIN, true, token())
        val listener = factory.sdk.listener!!
        val proofEvent = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }
        val completion = FakeCompletion()
        listener.onProof(VERIFY_TOKEN, completion)
        val proof = proofEvent.await() as FusionAuthEvent.ProofReady
        val failureEvent = async(start = CoroutineStart.UNDISPATCHED) { manager.events.first() }

        manager.cancelForBackground()

        val failure = failureEvent.await() as FusionAuthEvent.Failed
        assertEquals(proof.sessionId, failure.sessionId)
        assertEquals(11, failure.configurationGeneration)
        assertNull(proof.verifyToken.consume())
        assertEquals(listOf(false), completion.results)
        assertFalse(manager.hasActiveSession)
        assertEquals(1, factory.sdk.cancelCount)

        val late = FakeCompletion()
        listener.onProof("l".repeat(43), late)
        assertEquals(listOf(false), late.results)
    }

    @Test
    fun `debug no-op factory reports unavailable without vendor initialization`() {
        val factory = PlatformFusionAuthSdkFactory()

        assertFalse(factory.available)
        assertNull(factory.create())
    }

    @Test
    fun `one-time verify token accepts documented boundary and rejects unsafe values`() {
        assertEquals("x", OneTimeFusionVerifyToken.from("x")?.consume())
        assertNull(OneTimeFusionVerifyToken.from(""))
        assertNull(OneTimeFusionVerifyToken.from("x".repeat(4_097)))
        assertNull(OneTimeFusionVerifyToken.from("x\n"))
    }

    private fun manager(accepted: Boolean, factory: FakeFactory) = FusionAuthManager(
        factory = factory,
        privacyAuthorizationGate = FakePrivacyGate(accepted),
    )

    private fun token() = FusionAuthTokenResponse(
        flowId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
        schemeCode = "scheme-100001",
        authToken = "a".repeat(43),
        expiresAt = Instant.now().plusSeconds(600).toString(),
    )

    private class FakePrivacyGate(private val accepted: Boolean) : PrivacyAuthorizationGate {
        override suspend fun isAccepted(): Boolean = accepted

        override fun revoke() = Unit

        override fun allowAfterDurableAcceptance(): Boolean = accepted
    }

    private class FakeFactory(override val available: Boolean) : FusionAuthSdkFactory {
        val sdk = FakeSdk()
        var createCount = 0

        override fun create(): FusionAuthSdk? {
            createCount += 1
            return sdk
        }
    }

    private class FakeHost(
        override val isAvailable: Boolean = true,
    ) : FusionAuthHost {
        var launchCount = 0

        override fun launch(
            sdk: FusionAuthSdk,
            schemeCode: String,
            authToken: String,
            listener: FusionAuthSdkListener,
        ): Boolean {
            launchCount += 1
            (sdk as FakeSdk).listener = listener
            return true
        }
    }

    private class FakeSdk : FusionAuthSdk {
        var listener: FusionAuthSdkListener? = null
        var cancelCount = 0

        override fun start(
            activity: android.app.Activity,
            schemeCode: String,
            authToken: String,
            listener: FusionAuthSdkListener,
        ): Boolean = error("FakeHost bypasses Android Activity")

        override fun cancel() {
            cancelCount += 1
        }
    }

    private class FakeCompletion : FusionAuthProofCompletion {
        val results = mutableListOf<Boolean>()

        override fun complete(success: Boolean) {
            results += success
        }
    }

    private companion object {
        const val VERIFY_TOKEN = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"
    }
}
