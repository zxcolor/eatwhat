package com.chishenme.app.feature.consent

import com.chishenme.app.data.local.AppPreferences
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.first

/**
 * Process-wide privacy authority shared by every authentication entry point.
 *
 * A UI route is not a security boundary. The repository and both native OAuth
 * adapters therefore consult this gate immediately before starting work. A
 * withdrawal advances [generation] synchronously, so checks that were already
 * in flight cannot authorize work after the withdrawal linearization point.
 */
interface PrivacyAuthorizationGate {
    suspend fun isAccepted(): Boolean

    fun revoke()

    fun allowAfterDurableAcceptance(): Boolean
}

@Singleton
class AppPrivacyAuthorizationGate @Inject constructor(
    private val preferences: AppPreferences,
    private val withdrawalMarker: PrivacyWithdrawalMarkerStore,
) : PrivacyAuthorizationGate {
    private val generation = AtomicLong(0L)

    @Volatile
    private var processBlocked = withdrawalMarker.isBlocked()

    override suspend fun isAccepted(): Boolean {
        val expectedGeneration = generation.get()
        if (processBlocked || withdrawalMarker.isBlocked()) return false
        val accepted = preferences.privacyAccepted.first()
        return accepted &&
            generation.get() == expectedGeneration &&
            !processBlocked &&
            !withdrawalMarker.isBlocked()
    }

    override fun revoke() {
        processBlocked = true
        generation.incrementAndGet()
    }

    override fun allowAfterDurableAcceptance(): Boolean {
        if (withdrawalMarker.isBlocked()) return false
        processBlocked = false
        generation.incrementAndGet()
        return true
    }
}

