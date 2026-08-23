package com.chishenme.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundConfigRefreshGateTest {
    @Test
    fun `initial and repeated starts do not duplicate the first configuration request`() {
        val gate = ForegroundConfigRefreshGate()

        assertFalse(gate.onStarted())
        assertFalse(gate.onStarted())
    }

    @Test
    fun `each observed stop start transition requests exactly one refresh`() {
        val gate = ForegroundConfigRefreshGate()

        gate.onStopped()
        assertTrue(gate.onStarted())
        assertFalse(gate.onStarted())

        gate.onStopped()
        assertTrue(gate.onStarted())
        assertFalse(gate.onStarted())
    }
}
