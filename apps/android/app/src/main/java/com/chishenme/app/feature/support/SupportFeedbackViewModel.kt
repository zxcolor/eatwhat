package com.chishenme.app.feature.support

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.SupportFeedbackActions
import com.chishenme.app.data.SupportFeedbackFailureKind
import com.chishenme.app.data.SupportFeedbackOutcome
import com.chishenme.app.data.remote.SupportFeedbackCategory
import com.chishenme.app.data.remote.SupportFeedbackContract
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SubmittedSupportFeedback(
    val feedbackId: String,
    val retentionAfterClosureDays: Int,
)

data class SupportFeedbackUiState(
    val category: SupportFeedbackCategory = SupportFeedbackCategory.PRODUCT,
    val message: String = "",
    val submissionId: String = UUID.randomUUID().toString(),
    val supportFeedbackEnabled: Boolean = false,
    val submitting: Boolean = false,
    val capabilityTransitionBusy: Boolean = false,
    val forceGuest: Boolean = false,
    val guestConfirmationRequired: Boolean = false,
    val failureMessage: String? = null,
    val submitted: SubmittedSupportFeedback? = null,
) {
    val messageLength: Int
        get() = SupportFeedbackContract.normalizeMessage(message).let { normalized ->
            normalized.codePointCount(0, normalized.length)
        }

    val canSubmit: Boolean
        get() = supportFeedbackEnabled &&
            !submitting &&
            !capabilityTransitionBusy &&
            !guestConfirmationRequired &&
            SupportFeedbackContract.isValidMessage(message)
}

internal fun rotateSubmissionIdForDraftChange(
    currentValue: String,
    nextValue: String,
    currentSubmissionId: String,
    newSubmissionId: () -> String,
): String = if (currentValue == nextValue) currentSubmissionId else newSubmissionId()

@HiltViewModel
class SupportFeedbackViewModel @Inject constructor(
    private val repository: SupportFeedbackActions,
    private val runtimeAppVersionGate: RuntimeAppVersionGate,
) : ViewModel() {
    private val mutableState = MutableStateFlow(SupportFeedbackUiState())
    val state: StateFlow<SupportFeedbackUiState> = mutableState.asStateFlow()
    private var submissionJob: Job? = null
    private var submissionGeneration = 0L

    init {
        viewModelScope.launch {
            runtimeAppVersionGate.state.collect { gate ->
                if (!gate.remoteFeaturesAllowed) applyCapability(false)
            }
        }
    }

    /**
     * The destination can survive on an old navigation stack while remote
     * config changes. This is the authoritative behavioral gate: disabling it
     * cancels the in-flight operation and invalidates every late result.
     */
    fun start(enabled: Boolean) {
        applyCapability(enabled && runtimeAppVersionGate.currentState.remoteFeaturesAllowed)
    }

    private fun applyCapability(enabled: Boolean) {
        if (mutableState.value.supportFeedbackEnabled == enabled) return
        submissionGeneration += 1
        val revokedJob = if (!enabled) submissionJob?.also { it.cancel() } else null
        val transitionBusy = enabled && submissionJob?.isCompleted == false
        mutableState.update { current ->
            current.copy(
                supportFeedbackEnabled = enabled,
                submitting = false,
                capabilityTransitionBusy = transitionBusy,
                failureMessage = if (enabled) current.failureMessage else null,
                submitted = if (enabled) current.submitted else null,
                forceGuest = if (enabled) current.forceGuest else false,
                guestConfirmationRequired = if (enabled) {
                    current.guestConfirmationRequired
                } else {
                    false
                },
            )
        }
        if (revokedJob != null) finishCapabilityRevocation(revokedJob)
    }

    fun updateCategory(category: SupportFeedbackCategory) {
        mutableState.update { current ->
            if (current.submitting || current.category == category) current else current.copy(
                category = category,
                submissionId = UUID.randomUUID().toString(),
                failureMessage = null,
                submitted = null,
            )
        }
    }

    fun updateMessage(message: String) {
        val limited = SupportFeedbackContract.limitDraft(message)
        mutableState.update { current ->
            if (current.submitting) current else current.copy(
                message = limited,
                submissionId = rotateSubmissionIdForDraftChange(
                    current.message,
                    limited,
                    current.submissionId,
                    { UUID.randomUUID().toString() },
                ),
                failureMessage = null,
                submitted = null,
            )
        }
    }

    fun submit() {
        val draft = mutableState.value
        if (
            !runtimeAppVersionGate.currentState.remoteFeaturesAllowed ||
            !draft.canSubmit ||
            submissionJob?.isActive == true
        ) return
        val generation = ++submissionGeneration
        mutableState.update { it.copy(submitting = true, failureMessage = null, submitted = null) }
        val launched = viewModelScope.launch {
            try {
                when (
                    val outcome = repository.submit(
                        draft.submissionId,
                        draft.category,
                        draft.message,
                        forceGuest = draft.forceGuest,
                    )
                ) {
                    is SupportFeedbackOutcome.Success -> if (submissionAccessIsCurrent(generation)) {
                        mutableState.update {
                            if (!submissionAccessIsCurrent(generation)) it else it.copy(
                                message = "",
                                submissionId = UUID.randomUUID().toString(),
                                submitting = false,
                                forceGuest = false,
                                guestConfirmationRequired = false,
                                failureMessage = null,
                                submitted = SubmittedSupportFeedback(
                                    outcome.value.feedbackId,
                                    outcome.value.retentionAfterClosureDays,
                                ),
                            )
                        }
                    }
                    is SupportFeedbackOutcome.Failure -> if (submissionAccessIsCurrent(generation)) {
                        mutableState.update {
                            if (!submissionAccessIsCurrent(generation)) it else it.copy(
                                submissionId = if (outcome.kind == SupportFeedbackFailureKind.CONFLICT) {
                                    UUID.randomUUID().toString()
                                } else {
                                    it.submissionId
                                },
                                submitting = false,
                                forceGuest = if (outcome.kind == SupportFeedbackFailureKind.LOGIN_STATE) {
                                    false
                                } else {
                                    it.forceGuest
                                },
                                guestConfirmationRequired =
                                    outcome.kind == SupportFeedbackFailureKind.LOGIN_STATE,
                                failureMessage = outcome.message,
                            )
                        }
                    }
                }
            } catch (error: CancellationException) {
                if (submissionAccessIsCurrent(generation)) {
                    mutableState.update { it.copy(submitting = false) }
                }
                throw error
            }
        }
        submissionJob = launched
        launched.invokeOnCompletion {
            if (submissionJob === launched) {
                submissionJob = null
                if (submissionAccessIsCurrent(generation)) {
                    mutableState.update {
                        it.copy(submitting = false, capabilityTransitionBusy = false)
                    }
                }
            }
        }
    }

    fun confirmGuestSubmission() {
        mutableState.update { current ->
            if (
                !current.supportFeedbackEnabled ||
                !runtimeAppVersionGate.currentState.remoteFeaturesAllowed ||
                !current.guestConfirmationRequired ||
                current.submitting ||
                current.capabilityTransitionBusy
            ) current else current.copy(
                forceGuest = true,
                guestConfirmationRequired = false,
                failureMessage = "你已明确选择游客提交；本次反馈不会关联此前失效的账号会话",
            )
        }
    }

    fun clearDraft() {
        submissionGeneration += 1
        val active = submissionJob?.also { it.cancel() }
        val enabled = mutableState.value.supportFeedbackEnabled
        mutableState.value = SupportFeedbackUiState(
            supportFeedbackEnabled = enabled,
            capabilityTransitionBusy = enabled && active?.isCompleted == false,
        )
        if (active != null) finishCapabilityRevocation(active)
    }

    /**
     * A request implementation may need a NonCancellable cleanup section.
     * Keep the old job registered until that cleanup finishes so a fast
     * disable/enable cycle cannot overlap two submissions.
     */
    private fun finishCapabilityRevocation(revokedJob: Job) {
        viewModelScope.launch {
            revokedJob.join()
            if (submissionJob === revokedJob) submissionJob = null
            if (
                mutableState.value.supportFeedbackEnabled &&
                submissionJob?.isCompleted != false
            ) {
                mutableState.update {
                    it.copy(submitting = false, capabilityTransitionBusy = false)
                }
            }
        }
    }

    private fun submissionAccessIsCurrent(generation: Long): Boolean =
        generation == submissionGeneration &&
            runtimeAppVersionGate.currentState.remoteFeaturesAllowed &&
            mutableState.value.supportFeedbackEnabled
}
