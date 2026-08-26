package com.chishenme.app

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import org.junit.Assert.assertEquals
import org.junit.Test

class FusionProcessLifecycleObserverTest {
    @Test
    fun `only whole-process stop cancels an active fusion scene`() {
        var cancellations = 0
        val observer = FusionProcessLifecycleObserver { cancellations += 1 }
        val owner = object : LifecycleOwner {
            override val lifecycle: Lifecycle = LifecycleRegistry(this)
        }

        observer.onStateChanged(owner, Lifecycle.Event.ON_START)
        observer.onStateChanged(owner, Lifecycle.Event.ON_RESUME)
        observer.onStateChanged(owner, Lifecycle.Event.ON_PAUSE)
        assertEquals(0, cancellations)

        observer.onStateChanged(owner, Lifecycle.Event.ON_STOP)
        assertEquals(1, cancellations)
    }
}
