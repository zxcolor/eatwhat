package com.chishenme.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FusionActivityVisibilityGateTest {
    @Test
    fun `main to vendor handoff stays foreground and vendor home backgrounds`() {
        val gate = FusionActivityVisibilityGate()

        gate.onActivityStarted() // MainActivity
        gate.onActivityStarted() // vendor Activity starts before MainActivity stops
        assertFalse(gate.onActivityStopped(isChangingConfigurations = false))
        assertTrue(gate.onActivityStopped(isChangingConfigurations = false))
    }

    @Test
    fun `configuration recreation does not revoke fusion scene`() {
        val gate = FusionActivityVisibilityGate()

        gate.onActivityStarted()
        assertFalse(gate.onActivityStopped(isChangingConfigurations = true))
        gate.onActivityStarted()
        assertTrue(gate.onActivityStopped(isChangingConfigurations = false))
    }
}
