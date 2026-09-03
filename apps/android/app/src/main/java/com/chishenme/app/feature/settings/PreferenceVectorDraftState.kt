package com.chishenme.app.feature.settings

import com.chishenme.app.data.remote.RecommendationPreferenceVector

/**
 * Keeps an in-progress slider draft ahead of asynchronous DataStore echoes.
 *
 * A quick second edit may be committed before the first write is observed. In that case the
 * first persisted value is stale and must not replace what the user is currently editing.
 */
internal data class PreferenceVectorDraftState(
    val value: RecommendationPreferenceVector,
    private val pending: PendingPreferenceVectorWrite? = null,
) {
    fun edit(next: RecommendationPreferenceVector): PreferenceVectorDraftState = copy(value = next)

    fun expectStored(): PreferenceVectorDraftState = copy(
        pending = PendingPreferenceVectorWrite(value = value, stored = true),
    )

    fun expectCleared(): PreferenceVectorDraftState = PreferenceVectorDraftState(
        value = RecommendationPreferenceVector.Default,
        pending = PendingPreferenceVectorWrite(
            value = RecommendationPreferenceVector.Default,
            stored = false,
        ),
    )

    fun synchronize(
        persisted: RecommendationPreferenceVector,
        stored: Boolean,
    ): PreferenceVectorDraftState {
        val expected = pending
        return when {
            expected == null -> copy(value = persisted)
            expected.value == persisted && expected.stored == stored ->
                PreferenceVectorDraftState(value = persisted)
            else -> this
        }
    }

    internal val awaitingPersistence: Boolean
        get() = pending != null
}

internal data class PendingPreferenceVectorWrite(
    val value: RecommendationPreferenceVector,
    val stored: Boolean,
)
