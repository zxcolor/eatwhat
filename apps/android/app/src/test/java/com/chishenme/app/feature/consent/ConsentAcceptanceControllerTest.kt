package com.chishenme.app.feature.consent

import java.io.IOException
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConsentAcceptanceControllerTest {
    @Test
    fun `saving is visible immediately and repeated taps do not repeat acceptance`() = runTest {
        val finish = CompletableDeferred<Boolean>()
        var calls = 0
        var accepted = 0
        val controller = ConsentAcceptanceController(this, {
            calls += 1
            finish.await()
        }, { accepted += 1 })

        controller.submit()
        controller.submit()
        assertEquals(ConsentAcceptanceState.SAVING, controller.state.value)
        assertEquals(1, calls)
        finish.complete(true)
        runCurrent()
        assertEquals(ConsentAcceptanceState.ACCEPTED, controller.state.value)
        controller.submit()
        assertEquals(1, calls)
        assertEquals(1, accepted)
    }

    @Test
    fun `durable failures are visible keep privacy closed and allow an explicit retry`() = runTest {
        for (failure in listOf("preferences", "session", "marker")) {
            var unavailable = true
            var authAllowed = false
            var acceptedCallbacks = 0
            var marker = false
            val persisted = MutableStateFlow(false)
            val coordinator = PrivacyConsentCoordinator(
                persistedConsent = persisted,
                persistConsent = {
                    if (unavailable && failure == "preferences") throw IOException("unavailable")
                    persisted.value = it
                },
                revokeAuthAttempts = { authAllowed = false },
                allowAuthAttempts = { authAllowed = true; true },
                clearLocalSession = {
                    if (unavailable && failure == "session") throw IOException("unavailable")
                },
                durableWithdrawalBlocked = { marker },
                blockWithdrawalDurably = { marker = true; true },
                clearDurableWithdrawalBlock = {
                    if (unavailable && failure == "marker") false else { marker = false; true }
                },
                scope = backgroundScope,
            )
            val controller = ConsentAcceptanceController(this, coordinator::acceptPrivacy) {
                acceptedCallbacks += 1
            }

            controller.submit()
            runCurrent()
            assertEquals(failure, ConsentAcceptanceState.FAILED, controller.state.value)
            assertEquals(false, coordinator.privacyAccepted.value)
            assertFalse(authAllowed)
            assertEquals(0, acceptedCallbacks)

            unavailable = false
            controller.submit()
            runCurrent()
            assertEquals(ConsentAcceptanceState.ACCEPTED, controller.state.value)
            assertEquals(true, coordinator.privacyAccepted.value)
            assertTrue(authAllowed)
            assertEquals(1, acceptedCallbacks)
        }
    }

    @Test
    fun `withdrawal rejects even a non cooperative late acceptance presentation`() = runTest {
        var pending: Continuation<Boolean>? = null
        var accepted = 0
        val controller = ConsentAcceptanceController(this, {
            suspendCoroutine { pending = it }
        }, { accepted += 1 })
        controller.submit()
        assertEquals(ConsentAcceptanceState.SAVING, controller.state.value)

        controller.resetForWithdrawal()
        checkNotNull(pending).resume(true)
        runCurrent()

        assertEquals(ConsentAcceptanceState.IDLE, controller.state.value)
        assertEquals(0, accepted)
        controller.submit()
        checkNotNull(pending).resume(false)
        runCurrent()
        assertEquals(ConsentAcceptanceState.FAILED, controller.state.value)
    }
}
