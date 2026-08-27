package com.chishenme.app.auth.fusion

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FusionAuthCallbackGateTest {
    @Test
    fun `synchronous refresh fails closed without changing lifecycle state`() {
        val resource = TestResource()
        val gate = gate()

        val refreshToken = gate.failClosedRefreshToken()

        assertEquals("", refreshToken)
        assertFalse(gate.isClosed)
        assertTrue(gate.attach(resource))
        assertTrue(gate.close())
        assertEquals(1, resource.releaseCount.get())
    }

    @Test
    fun `terminal listener runs outside lock and may reenter close`() {
        val resource = TestResource()
        val gate = gate()
        assertTrue(gate.attach(resource))
        val closeFinished = CountDownLatch(1)
        val closeResult = AtomicBoolean(false)

        assertTrue(
            gate.notifyTerminal {
                val closer = thread(name = "fusion-gate-closer") {
                    closeResult.set(gate.close())
                    closeFinished.countDown()
                }
                assertTrue(closeFinished.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
                closer.join()
            },
        )

        assertTrue(closeResult.get())
        assertTrue(gate.isClosed)
        assertEquals(1, resource.releaseCount.get())
        assertFalse(gate.notifyTerminal { error("late terminal callback") })
        assertFalse(gate.close())
    }

    @Test
    fun `close during operation defers release until operation returns`() {
        val resource = TestResource()
        val gate = gate()
        assertTrue(gate.attach(resource))
        val operationEntered = CountDownLatch(1)
        val allowOperationReturn = CountDownLatch(1)
        val operationCompleted = CountDownLatch(1)
        val operationRan = AtomicBoolean(false)
        val waitSucceeded = AtomicBoolean(false)

        val worker = thread(name = "fusion-gate-operation") {
            operationRan.set(
                gate.runIfOpen {
                    operationEntered.countDown()
                    waitSucceeded.set(
                        allowOperationReturn.await(TIMEOUT_SECONDS, TimeUnit.SECONDS),
                    )
                    it.operationCount.incrementAndGet()
                },
            )
            operationCompleted.countDown()
        }

        assertTrue(operationEntered.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        assertTrue(gate.close())
        assertEquals(0, resource.releaseCount.get())
        assertFalse(gate.runIfOpen { error("closed gate accepted a new operation") })

        allowOperationReturn.countDown()
        assertTrue(operationCompleted.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        worker.join()

        assertTrue(waitSucceeded.get())
        assertTrue(operationRan.get())
        assertEquals(1, resource.operationCount.get())
        assertEquals(1, resource.releaseCount.get())
        assertFalse(gate.close())
        assertEquals(1, resource.releaseCount.get())
    }

    @Test
    fun `close before attach rejects and releases late resource`() {
        val resource = TestResource()
        val gate = gate()

        assertTrue(gate.close())
        assertFalse(gate.attach(resource))

        assertEquals(1, resource.releaseCount.get())
        assertTrue(gate.isClosed)
    }

    @Test
    fun `scene start is claimed once across concurrent callbacks`() {
        val resource = TestResource()
        val gate = gate()
        assertTrue(gate.attach(resource))
        val start = CountDownLatch(1)
        val done = CountDownLatch(CONCURRENT_CALLS)
        val accepted = AtomicInteger(0)
        val calls = AtomicInteger(0)
        val workers = (1..CONCURRENT_CALLS).map { index ->
            thread(name = "fusion-scene-$index") {
                start.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                if (gate.startSceneOnce { calls.incrementAndGet() }) {
                    accepted.incrementAndGet()
                }
                done.countDown()
            }
        }

        start.countDown()
        assertTrue(done.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        workers.forEach(Thread::join)

        assertEquals(1, accepted.get())
        assertEquals(1, calls.get())
        assertTrue(gate.close())
        assertEquals(1, resource.releaseCount.get())
    }

    @Test
    fun `proof completion is one shot and late completion is ignored`() {
        val activeResource = TestResource()
        val activeGate = gate()
        assertTrue(activeGate.attach(activeResource))
        val completion = activeGate.oneShotOperation { current, success ->
            current.completionValues += success
        }

        completion(true)
        completion(false)

        assertEquals(listOf(true), activeResource.completionValues.toList())
        assertTrue(activeGate.close())
        assertEquals(1, activeResource.releaseCount.get())

        val lateResource = TestResource()
        val closedGate = gate()
        assertTrue(closedGate.attach(lateResource))
        val lateCompletion = closedGate.oneShotOperation { current, success ->
            current.completionValues += success
        }
        assertTrue(closedGate.close())

        lateCompletion(false)

        assertTrue(lateResource.completionValues.isEmpty())
        assertEquals(1, lateResource.releaseCount.get())
    }

    @Test
    fun `failure and finish race delivers one terminal callback`() {
        val resource = TestResource()
        val gate = gate()
        assertTrue(gate.attach(resource))
        val start = CountDownLatch(1)
        val done = CountDownLatch(2)
        val delivered = Collections.synchronizedList(mutableListOf<String>())
        val claimed = AtomicInteger(0)

        val failure = thread(name = "fusion-terminal-failure") {
            start.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (gate.notifyTerminal { delivered += "failure" }) claimed.incrementAndGet()
            done.countDown()
        }
        val finish = thread(name = "fusion-terminal-finish") {
            start.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (gate.notifyTerminal { delivered += "finish" }) claimed.incrementAndGet()
            done.countDown()
        }

        start.countDown()
        assertTrue(done.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        failure.join()
        finish.join()

        assertEquals(1, claimed.get())
        assertEquals(1, delivered.size)
        assertTrue(gate.close())
        assertEquals(1, resource.releaseCount.get())
    }

    private fun gate(): FusionAuthCallbackGate<TestResource> =
        FusionAuthCallbackGate { resource -> resource.releaseCount.incrementAndGet() }

    private class TestResource {
        val releaseCount = AtomicInteger(0)
        val operationCount = AtomicInteger(0)
        val completionValues = Collections.synchronizedList(mutableListOf<Boolean>())
    }

    private companion object {
        const val CONCURRENT_CALLS = 8
        const val TIMEOUT_SECONDS = 5L
    }
}
