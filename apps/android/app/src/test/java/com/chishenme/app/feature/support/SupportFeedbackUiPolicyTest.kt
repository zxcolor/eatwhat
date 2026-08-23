package com.chishenme.app.feature.support

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SupportFeedbackUiPolicyTest {
    @Test
    fun `settings entry has an action only when the server capability is enabled`() {
        assertFalse(showSupportFeedbackEntryAction(false))
        assertTrue(showSupportFeedbackEntryAction(true))
    }

    @Test
    fun `submission controls require both current server and view model capability`() {
        assertFalse(showSupportFeedbackSubmissionControls(false, false))
        assertFalse(showSupportFeedbackSubmissionControls(false, true))
        assertFalse(showSupportFeedbackSubmissionControls(true, false))
        assertTrue(showSupportFeedbackSubmissionControls(true, true))
    }
}
