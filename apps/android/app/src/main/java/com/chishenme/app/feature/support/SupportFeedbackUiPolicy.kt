package com.chishenme.app.feature.support

/** The settings entry is actionable only from the latest verified server capability. */
internal fun showSupportFeedbackEntryAction(serverCapabilityEnabled: Boolean): Boolean =
    serverCapabilityEnabled

/**
 * A stale destination must satisfy both the latest server capability and the
 * ViewModel's lifecycle gate before any submission controls are rendered.
 */
internal fun showSupportFeedbackSubmissionControls(
    serverCapabilityEnabled: Boolean,
    viewModelCapabilityEnabled: Boolean,
): Boolean = serverCapabilityEnabled && viewModelCapabilityEnabled
