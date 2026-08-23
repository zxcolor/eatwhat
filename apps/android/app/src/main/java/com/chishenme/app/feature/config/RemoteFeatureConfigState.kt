package com.chishenme.app.feature.config

import com.chishenme.app.data.remote.FeatureConfig

/**
 * Process-local lifecycle of the server feature configuration.
 *
 * [generation] changes at the beginning of every refresh. Keeping LOADING
 * distinct from a terminal failure lets consumers revoke remote work
 * immediately without mistaking a transient foreground refresh for an
 * explicit server shutdown.
 */
sealed interface RemoteFeatureConfigState {
    val generation: Long

    data class Loading(override val generation: Long) : RemoteFeatureConfigState

    data class Ready(
        override val generation: Long,
        val config: FeatureConfig,
    ) : RemoteFeatureConfigState

    data class Unavailable(override val generation: Long) : RemoteFeatureConfigState

    data class Incompatible(override val generation: Long) : RemoteFeatureConfigState
}

internal val RemoteFeatureConfigState.configOrNull: FeatureConfig?
    get() = (this as? RemoteFeatureConfigState.Ready)?.config
