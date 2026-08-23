package com.chishenme.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundShareCardCleanupGateTest {
    @Test
    fun `cold start is owned by application cleanup and later foreground requests cleanup`() {
        val gate = ForegroundShareCardCleanupGate()

        assertFalse(gate.onActivityStarted())
        gate.onActivityStopped(isChangingConfigurations = false)

        assertTrue(gate.onActivityStarted())
    }

    @Test
    fun `configuration recreation is not treated as a foreground return`() {
        val gate = ForegroundShareCardCleanupGate()
        assertFalse(gate.onActivityStarted())

        gate.onActivityStopped(isChangingConfigurations = true)
        assertFalse(gate.onActivityStarted())

        gate.onActivityStopped(isChangingConfigurations = false)
        assertTrue(gate.onActivityStarted())
    }

    @Test
    fun `overlapping app activities do not create false foreground transitions`() {
        val gate = ForegroundShareCardCleanupGate()
        assertFalse(gate.onActivityStarted())
        assertFalse(gate.onActivityStarted())

        gate.onActivityStopped(isChangingConfigurations = false)
        assertFalse(gate.onActivityStarted())
        gate.onActivityStopped(isChangingConfigurations = false)
        gate.onActivityStopped(isChangingConfigurations = false)

        assertTrue(gate.onActivityStarted())
    }
}
