package com.chishenme.app.auth.fusion

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns one provider resource and serializes its lifecycle with asynchronous callbacks.
 *
 * State is claimed under [lock], but provider operations, resource release and app
 * callbacks always run outside it. Closing rejects new operations immediately. If an
 * operation is already in flight, release is deferred until its `finally` block returns.
 */
internal class FusionAuthCallbackGate<Resource : Any>(
    private val releaseResource: (Resource) -> Unit,
) {
    private val lock = Any()
    private var closed = false
    private var terminalDelivered = false
    private var resourceClaimed = false
    private var resource: Resource? = null
    private var inFlightOperations = 0
    private var sceneStarted = false

    val isClosed: Boolean
        get() = synchronized(lock) { closed }

    /**
     * Transfers ownership of [candidate] to this gate exactly once.
     * A rejected candidate is released outside [lock] before this method returns.
     */
    fun attach(candidate: Resource): Boolean {
        val accepted = synchronized(lock) {
            if (closed || resourceClaimed) {
                false
            } else {
                resourceClaimed = true
                resource = candidate
                true
            }
        }
        if (!accepted) releaseResource(candidate)
        return accepted
    }

    /** Runs [operation] only while open and keeps the resource alive until it returns. */
    fun runIfOpen(operation: (Resource) -> Unit): Boolean =
        runOperation(startScene = false, operation = operation)

    /** Claims the one allowed scene start and runs it with the same operation lease. */
    fun startSceneOnce(operation: (Resource) -> Unit): Boolean =
        runOperation(startScene = true, operation = operation)

    /**
     * Wraps a provider proof continuation so only its first invocation can acquire a
     * resource lease. A duplicate or late invocation after close is a no-op.
     */
    fun oneShotOperation(operation: (Resource, Boolean) -> Unit): (Boolean) -> Unit {
        val completed = AtomicBoolean(false)
        return { success ->
            if (completed.compareAndSet(false, true)) {
                runIfOpen { current -> operation(current, success) }
            }
        }
    }

    /** Never reuse a previous server token when no authorized refresh path exists. */
    fun failClosedRefreshToken(): String = ""

    /**
     * Claims the single app-visible terminal event. The callback runs outside [lock]
     * and may synchronously re-enter [close] through the manager cancellation path.
     */
    fun notifyTerminal(listener: () -> Unit): Boolean {
        val shouldNotify = synchronized(lock) {
            if (closed || terminalDelivered) {
                false
            } else {
                terminalDelivered = true
                true
            }
        }
        if (shouldNotify) listener()
        return shouldNotify
    }

    /** Returns true only for the owner that changed the lifecycle to closed. */
    fun close(): Boolean {
        var pendingRelease: Resource? = null
        val changed = synchronized(lock) {
            if (closed) {
                false
            } else {
                closed = true
                pendingRelease = takeResourceForRelease()
                true
            }
        }
        pendingRelease?.let(releaseResource)
        return changed
    }

    private fun runOperation(
        startScene: Boolean,
        operation: (Resource) -> Unit,
    ): Boolean {
        val current = synchronized(lock) {
            if (closed || terminalDelivered || (startScene && sceneStarted)) {
                null
            } else {
                resource?.also {
                    if (startScene) sceneStarted = true
                    inFlightOperations += 1
                }
            }
        } ?: return false

        try {
            operation(current)
            return true
        } finally {
            finishOperation()
        }
    }

    private fun finishOperation() {
        val pendingRelease = synchronized(lock) {
            check(inFlightOperations > 0)
            inFlightOperations -= 1
            takeResourceForRelease()
        }
        pendingRelease?.let(releaseResource)
    }

    /** Must be called only while holding [lock]. */
    private fun takeResourceForRelease(): Resource? {
        if (!closed || inFlightOperations != 0) return null
        return resource.also { resource = null }
    }
}
