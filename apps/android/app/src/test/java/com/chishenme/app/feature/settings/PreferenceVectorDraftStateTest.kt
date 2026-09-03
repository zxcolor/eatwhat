package com.chishenme.app.feature.settings

import com.chishenme.app.data.remote.RecommendationPreferenceVector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreferenceVectorDraftStateTest {
    @Test
    fun `stale first write cannot replace a newer rapid slider commit`() {
        val first = RecommendationPreferenceVector(quality = 80)
        val second = first.copy(time = 65)
        var state = PreferenceVectorDraftState(RecommendationPreferenceVector.Default)
            .edit(first)
            .expectStored()
            .edit(second)
            .expectStored()

        state = state.synchronize(persisted = first, stored = true)

        assertEquals(second, state.value)
        assertTrue(state.awaitingPersistence)

        state = state.synchronize(persisted = second, stored = true)

        assertEquals(second, state.value)
        assertFalse(state.awaitingPersistence)
    }

    @Test
    fun `clear acknowledgement uses stored state even when value is already default`() {
        var state = PreferenceVectorDraftState(RecommendationPreferenceVector.Default)
            .expectStored()
            .synchronize(RecommendationPreferenceVector.Default, stored = true)
            .expectCleared()

        assertTrue(state.awaitingPersistence)

        state = state.synchronize(
            persisted = RecommendationPreferenceVector.Default,
            stored = false,
        )

        assertEquals(RecommendationPreferenceVector.Default, state.value)
        assertFalse(state.awaitingPersistence)
    }

    @Test
    fun `external persisted change is adopted when no local write is pending`() {
        val persisted = RecommendationPreferenceVector(diversity = 35)

        val synchronized = PreferenceVectorDraftState(RecommendationPreferenceVector.Default)
            .synchronize(persisted = persisted, stored = true)

        assertEquals(persisted, synchronized.value)
        assertFalse(synchronized.awaitingPersistence)
    }
}
