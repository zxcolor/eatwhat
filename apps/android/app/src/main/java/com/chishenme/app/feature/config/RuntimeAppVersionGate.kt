package com.chishenme.app.feature.config

import com.chishenme.app.BuildConfig
import com.chishenme.app.domain.AppVersionPolicy
import com.chishenme.app.domain.AppVersionStatus
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Process-wide authority for minimum-version enforcement.
 *
 * A remote request may start only with a lease issued from a trusted, compatible
 * feature-config generation. UPDATE_REQUIRED is deliberately sticky across
 * loading and failed refreshes; only a later trusted compatible config can lift it.
 */
@Singleton
class RuntimeAppVersionGate internal constructor(
    private val currentVersion: String,
) {
    @Inject
    constructor() : this(BuildConfig.VERSION_NAME)

    enum class Status { UNKNOWN, COMPATIBLE, UPDATE_REQUIRED }

    data class State(
        val status: Status = Status.UNKNOWN,
        val minimumSupportedVersion: String? = null,
        val observedConfigurationGeneration: Long? = null,
        val trustedConfigurationGeneration: Long? = null,
        val failClosedGuestDecisionAllowed: Boolean = false,
    ) {
        val remoteFeaturesAllowed: Boolean
            get() = status == Status.COMPATIBLE && trustedConfigurationGeneration != null
    }

    class RemoteAccessLease internal constructor(
        internal val configurationGeneration: Long,
    )

    class RecommendationAccessLease internal constructor(
        internal val configurationGeneration: Long,
        internal val trustedCompatibleConfiguration: Boolean,
    )

    private val mutableState = MutableStateFlow(State())
    private val configurationGenerationLock = Any()
    private var lastIssuedConfigurationGeneration = 0L
    val state: StateFlow<State> = mutableState.asStateFlow()

    val currentState: State
        get() = mutableState.value

    /**
     * Allocates a process-wide monotonically increasing configuration generation
     * and revokes the previously trusted generation before network work starts.
     * ViewModels may be recreated while this singleton survives, so generation
     * ownership cannot safely live in an individual ViewModel.
     */
    fun beginConfigurationRefresh(): Long = synchronized(configurationGenerationLock) {
        val observed = mutableState.value.observedConfigurationGeneration ?: 0L
        val floor = maxOf(lastIssuedConfigurationGeneration, observed)
        check(floor < Long.MAX_VALUE) { "Configuration generation exhausted" }
        val generation = floor + 1L
        lastIssuedConfigurationGeneration = generation
        markConfigurationUntrusted(generation)
        generation
    }

    /** Called synchronously before a feature-config refresh is launched. */
    fun markConfigurationUntrusted(generation: Long) = synchronized(configurationGenerationLock) {
        mutableState.update { current ->
            val observed = current.observedConfigurationGeneration
            if (observed != null && generation < observed) return@update current
            if (current.status == Status.UPDATE_REQUIRED) {
                current.copy(
                    observedConfigurationGeneration = generation,
                    trustedConfigurationGeneration = null,
                    failClosedGuestDecisionAllowed = false,
                )
            } else {
                State(observedConfigurationGeneration = generation)
            }
        }
    }

    /**
     * Preserves the established guest rules-only fallback after a first config
     * outage. This does not issue a trusted lease, so result actions, accounts,
     * persistence, feedback and search remain unavailable.
     */
    fun markConfigurationUnavailable(generation: Long) {
        mutableState.update { current ->
            if (current.observedConfigurationGeneration != generation) return@update current
            if (current.status == Status.UPDATE_REQUIRED) {
                current.copy(
                    observedConfigurationGeneration = generation,
                    trustedConfigurationGeneration = null,
                    failClosedGuestDecisionAllowed = false,
                )
            } else {
                State(
                    observedConfigurationGeneration = generation,
                    failClosedGuestDecisionAllowed = true,
                )
            }
        }
    }

    fun markConfigurationIncompatible(generation: Long) {
        mutableState.update { current ->
            if (current.observedConfigurationGeneration != generation) return@update current
            if (current.status == Status.UPDATE_REQUIRED) {
                current.copy(
                    observedConfigurationGeneration = generation,
                    trustedConfigurationGeneration = null,
                    failClosedGuestDecisionAllowed = false,
                )
            } else {
                State(observedConfigurationGeneration = generation)
            }
        }
    }

    /** Accepts only a response already validated as the current config generation. */
    fun acceptTrustedConfiguration(
        generation: Long,
        minimumSupportedVersion: String,
    ) {
        mutableState.update { current ->
            if (current.observedConfigurationGeneration != generation) return@update current
            when (val status = AppVersionPolicy.evaluate(currentVersion, minimumSupportedVersion)) {
                is AppVersionStatus.Compatible -> State(
                    status = Status.COMPATIBLE,
                    minimumSupportedVersion = status.minimumVersion,
                    observedConfigurationGeneration = generation,
                    trustedConfigurationGeneration = generation,
                )
                is AppVersionStatus.UpdateRequired -> State(
                    status = Status.UPDATE_REQUIRED,
                    minimumSupportedVersion = status.minimumVersion,
                    observedConfigurationGeneration = generation,
                    trustedConfigurationGeneration = generation,
                )
                AppVersionStatus.ConfigurationUnavailable -> if (
                    current.status == Status.UPDATE_REQUIRED
                ) {
                    current.copy(
                        observedConfigurationGeneration = generation,
                        trustedConfigurationGeneration = null,
                        failClosedGuestDecisionAllowed = false,
                    )
                } else {
                    State(observedConfigurationGeneration = generation)
                }
            }
        }
    }

    fun acquireRemoteAccessLease(
        expectedConfigurationGeneration: Long? = null,
    ): RemoteAccessLease? {
        val snapshot = mutableState.value
        val generation = snapshot.trustedConfigurationGeneration ?: return null
        if (!snapshot.remoteFeaturesAllowed) return null
        if (expectedConfigurationGeneration != null && expectedConfigurationGeneration != generation) {
            return null
        }
        return RemoteAccessLease(generation)
    }

    fun isRemoteAccessCurrent(lease: RemoteAccessLease): Boolean {
        val snapshot = mutableState.value
        return snapshot.remoteFeaturesAllowed &&
            snapshot.trustedConfigurationGeneration == lease.configurationGeneration
    }

    fun acquireRecommendationAccessLease(
        expectedConfigurationGeneration: Long,
    ): RecommendationAccessLease? {
        val snapshot = mutableState.value
        if (
            snapshot.remoteFeaturesAllowed &&
            snapshot.trustedConfigurationGeneration == expectedConfigurationGeneration
        ) {
            return RecommendationAccessLease(expectedConfigurationGeneration, true)
        }
        if (
            snapshot.status == Status.UNKNOWN &&
            snapshot.failClosedGuestDecisionAllowed &&
            snapshot.observedConfigurationGeneration == expectedConfigurationGeneration
        ) {
            return RecommendationAccessLease(expectedConfigurationGeneration, false)
        }
        return null
    }

    fun isRecommendationAccessCurrent(lease: RecommendationAccessLease): Boolean {
        val snapshot = mutableState.value
        return if (lease.trustedCompatibleConfiguration) {
            snapshot.remoteFeaturesAllowed &&
                snapshot.trustedConfigurationGeneration == lease.configurationGeneration
        } else {
            snapshot.status == Status.UNKNOWN &&
                snapshot.failClosedGuestDecisionAllowed &&
                snapshot.observedConfigurationGeneration == lease.configurationGeneration
        }
    }
}
