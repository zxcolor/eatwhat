package com.chishenme.app.feature.support

import com.chishenme.app.data.SupportFeedbackActions
import com.chishenme.app.data.remote.SupportFeedbackApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.http.POST

class SupportFeedbackMemoryBoundaryTest {
    @Test
    fun `draft keeps its id across retry and rotates only when content changes`() {
        val current = "0192f014-7d64-4b59-8fc1-513465daae10"
        val next = "0192f014-7d64-4b59-8fc1-513465daae11"

        assertEquals(
            current,
            rotateSubmissionIdForDraftChange("same", "same", current) { next },
        )
        assertNotEquals(
            current,
            rotateSubmissionIdForDraftChange("before", "after", current) { next },
        )
    }

    @Test
    fun `authentication failure blocks retry until guest is explicitly confirmed`() {
        val blocked = SupportFeedbackUiState(
            message = "这个反馈正文已经满足最小长度要求",
            supportFeedbackEnabled = true,
            guestConfirmationRequired = true,
        )

        assertFalse(blocked.canSubmit)
        assertTrue(blocked.copy(guestConfirmationRequired = false, forceGuest = true).canSubmit)
    }

    @Test
    fun `view model has no persistence or saved state dependency`() {
        val parameterTypes = SupportFeedbackViewModel::class.java.declaredConstructors
            .flatMap { it.parameterTypes.toList() }
            .map { it.name }

        assertTrue(parameterTypes.contains(SupportFeedbackActions::class.java.name))
        assertFalse(parameterTypes.any { it.contains("DataStore") })
        assertFalse(parameterTypes.any { it.contains("SavedStateHandle") })
        assertFalse(parameterTypes.any { it.contains("DecisionHistory") })
    }

    @Test
    fun `transport exposes one static support endpoint`() {
        val methods = SupportFeedbackApi::class.java.declaredMethods
        assertEquals(1, methods.size)
        val endpoint = requireNotNull(methods.single().getAnnotation(POST::class.java))
        assertEquals("v1/support-feedback", endpoint.value)
    }
}
