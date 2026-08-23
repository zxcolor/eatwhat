package com.chishenme.app.feature.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeAppVersionGateTest {
    @Test
    fun `process refresh generations advance beyond an existing view model generation`() {
        val gate = RuntimeAppVersionGate("1.0.0")
        gate.markConfigurationUntrusted(41)
        gate.acceptTrustedConfiguration(41, "1.0.0")

        val first = gate.beginConfigurationRefresh()
        val second = gate.beginConfigurationRefresh()

        assertEquals(42L, first)
        assertEquals(43L, second)
        assertEquals(43L, gate.currentState.observedConfigurationGeneration)
        assertEquals(RuntimeAppVersionGate.Status.UNKNOWN, gate.currentState.status)
        assertNull(gate.acquireRemoteAccessLease())
    }

    @Test
    fun `update required stays sticky until a newer trusted compatible ready`() {
        val gate = RuntimeAppVersionGate("1.0.0")

        assertEquals(RuntimeAppVersionGate.Status.UNKNOWN, gate.currentState.status)
        gate.markConfigurationUntrusted(1)
        gate.acceptTrustedConfiguration(1, "2.0.0")
        assertEquals(RuntimeAppVersionGate.Status.UPDATE_REQUIRED, gate.currentState.status)
        assertEquals("2.0.0", gate.currentState.minimumSupportedVersion)

        gate.markConfigurationUntrusted(2)
        assertEquals(RuntimeAppVersionGate.Status.UPDATE_REQUIRED, gate.currentState.status)
        assertNull(gate.acquireRemoteAccessLease())
        gate.markConfigurationUnavailable(2)
        assertEquals(RuntimeAppVersionGate.Status.UPDATE_REQUIRED, gate.currentState.status)
        assertFalse(gate.currentState.failClosedGuestDecisionAllowed)

        gate.markConfigurationUntrusted(3)
        gate.markConfigurationIncompatible(3)
        assertEquals(RuntimeAppVersionGate.Status.UPDATE_REQUIRED, gate.currentState.status)

        gate.markConfigurationUntrusted(4)
        gate.acceptTrustedConfiguration(4, "latest")
        assertEquals(RuntimeAppVersionGate.Status.UPDATE_REQUIRED, gate.currentState.status)

        gate.markConfigurationUntrusted(5)
        gate.acceptTrustedConfiguration(5, "0.9.0")
        assertEquals(RuntimeAppVersionGate.Status.COMPATIBLE, gate.currentState.status)
        assertNotNull(gate.acquireRemoteAccessLease(5))
    }

    @Test
    fun `stale trusted ready cannot unlock a newer generation`() {
        val gate = RuntimeAppVersionGate("1.0.0")
        gate.markConfigurationUntrusted(1)
        gate.acceptTrustedConfiguration(1, "2.0.0")
        gate.markConfigurationUntrusted(2)

        gate.acceptTrustedConfiguration(1, "0.1.0")

        assertEquals(RuntimeAppVersionGate.Status.UPDATE_REQUIRED, gate.currentState.status)
        assertEquals(2L, gate.currentState.observedConfigurationGeneration)
        assertNull(gate.acquireRemoteAccessLease())
    }

    @Test
    fun `first unavailable config grants only a generation scoped guest recommendation lease`() {
        val gate = RuntimeAppVersionGate("1.0.0")
        gate.markConfigurationUntrusted(7)
        gate.markConfigurationUnavailable(7)

        assertEquals(RuntimeAppVersionGate.Status.UNKNOWN, gate.currentState.status)
        assertTrue(gate.currentState.failClosedGuestDecisionAllowed)
        assertNull(gate.acquireRemoteAccessLease())
        val guestLease = gate.acquireRecommendationAccessLease(7)
        assertNotNull(guestLease)
        assertFalse(guestLease!!.trustedCompatibleConfiguration)
        assertTrue(gate.isRecommendationAccessCurrent(guestLease))

        gate.markConfigurationUntrusted(8)
        assertFalse(gate.isRecommendationAccessCurrent(guestLease))
        assertNull(gate.acquireRecommendationAccessLease(8))
    }
}
