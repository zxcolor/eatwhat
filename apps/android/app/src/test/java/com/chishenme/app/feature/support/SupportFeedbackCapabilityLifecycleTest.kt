package com.chishenme.app.feature.support

import com.chishenme.app.data.SupportFeedbackActions
import com.chishenme.app.data.SupportFeedbackFailureKind
import com.chishenme.app.data.SupportFeedbackOutcome
import com.chishenme.app.data.remote.SupportFeedbackCategory
import com.chishenme.app.data.remote.SupportFeedbackResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SupportFeedbackCapabilityLifecycleTest {
    @Test
    fun `runtime gate revocation disables submission and preserves the local draft`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate()
            val actions = FakeSupportFeedbackActions()
            val viewModel = SupportFeedbackViewModel(actions, gate)
            viewModel.start(true)
            viewModel.updateMessage(VALID_MESSAGE)

            gate.markConfigurationUntrusted(2)
            runCurrent()
            viewModel.start(true)
            viewModel.submit()
            runCurrent()

            assertFalse(viewModel.state.value.supportFeedbackEnabled)
            assertFalse(viewModel.state.value.canSubmit)
            assertEquals(VALID_MESSAGE, viewModel.state.value.message)
            assertEquals(0, actions.submitCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `disabled capability never reaches the feedback repository`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val actions = FakeSupportFeedbackActions()
            val viewModel = SupportFeedbackViewModel(
                actions,
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.start(false)
            viewModel.updateMessage(VALID_MESSAGE)
            viewModel.submit()
            runCurrent()

            assertEquals(0, actions.submitCalls)
            assertFalse(viewModel.state.value.supportFeedbackEnabled)
            assertFalse(viewModel.state.value.canSubmit)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `enabled capability preserves guest submission behavior`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val actions = FakeSupportFeedbackActions()
            val viewModel = SupportFeedbackViewModel(
                actions,
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.start(true)
            viewModel.updateMessage(VALID_MESSAGE)
            viewModel.submit()
            runCurrent()

            assertEquals(1, actions.submitCalls)
            assertEquals(FEEDBACK_ID, viewModel.state.value.submitted?.feedbackId)
            assertEquals("", viewModel.state.value.message)
            assertTrue(viewModel.state.value.supportFeedbackEnabled)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `revocation clears a pending guest fallback while preserving the draft`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val actions = FakeSupportFeedbackActions().apply {
                operation = {
                    SupportFeedbackOutcome.Failure(
                        SupportFeedbackFailureKind.LOGIN_STATE,
                        "登录状态已失效",
                    )
                }
            }
            val viewModel = SupportFeedbackViewModel(
                actions,
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.start(true)
            viewModel.updateMessage(VALID_MESSAGE)
            val draftId = viewModel.state.value.submissionId
            viewModel.submit()
            runCurrent()
            assertTrue(viewModel.state.value.guestConfirmationRequired)

            viewModel.start(false)
            viewModel.start(true)
            runCurrent()

            val state = viewModel.state.value
            assertFalse(state.guestConfirmationRequired)
            assertFalse(state.forceGuest)
            assertEquals(VALID_MESSAGE, state.message)
            assertEquals(draftId, state.submissionId)
            assertTrue(state.canSubmit)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `revocation clears a previously confirmed guest fallback intent`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val actions = FakeSupportFeedbackActions().apply {
                operation = {
                    SupportFeedbackOutcome.Failure(
                        SupportFeedbackFailureKind.LOGIN_STATE,
                        "登录状态已失效",
                    )
                }
            }
            val viewModel = SupportFeedbackViewModel(
                actions,
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.start(true)
            viewModel.updateMessage(VALID_MESSAGE)
            viewModel.submit()
            runCurrent()
            viewModel.confirmGuestSubmission()
            assertTrue(viewModel.state.value.forceGuest)

            viewModel.start(false)
            viewModel.start(true)
            runCurrent()

            assertFalse(viewModel.state.value.forceGuest)
            assertFalse(viewModel.state.value.guestConfirmationRequired)
            assertTrue(viewModel.state.value.canSubmit)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `revocation cancels and serializes cleanup while ignoring the stale result`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val started = CompletableDeferred<Unit>()
            val cleanupRelease = CompletableDeferred<Unit>()
            val cleanupFinished = CompletableDeferred<Unit>()
            val actions = FakeSupportFeedbackActions().apply {
                operation = {
                    if (submitCalls == 1) {
                        started.complete(Unit)
                        try {
                            awaitCancellation()
                        } catch (_: CancellationException) {
                            withContext(NonCancellable) {
                                cleanupRelease.await()
                                cleanupFinished.complete(Unit)
                            }
                        }
                    }
                    success()
                }
            }
            val viewModel = SupportFeedbackViewModel(
                actions,
                com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
            )

            viewModel.start(true)
            viewModel.updateMessage(VALID_MESSAGE)
            viewModel.submit()
            runCurrent()
            assertTrue(started.isCompleted)

            viewModel.start(false)
            viewModel.start(true)
            runCurrent()

            assertTrue(viewModel.state.value.supportFeedbackEnabled)
            assertTrue(viewModel.state.value.capabilityTransitionBusy)
            assertFalse(viewModel.state.value.canSubmit)
            assertEquals(1, actions.submitCalls)

            viewModel.submit()
            runCurrent()
            assertEquals(1, actions.submitCalls)

            cleanupRelease.complete(Unit)
            runCurrent()

            assertTrue(cleanupFinished.isCompleted)
            assertFalse(viewModel.state.value.capabilityTransitionBusy)
            assertNull(viewModel.state.value.submitted)
            assertEquals(VALID_MESSAGE, viewModel.state.value.message)

            viewModel.submit()
            runCurrent()
            assertEquals(2, actions.submitCalls)
            assertEquals(FEEDBACK_ID, viewModel.state.value.submitted?.feedbackId)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private companion object {
        const val VALID_MESSAGE = "这个反馈正文已经满足最小长度要求"
        const val FEEDBACK_ID = "11111111-1111-4111-8111-111111111111"
    }
}

private class FakeSupportFeedbackActions : SupportFeedbackActions {
    var submitCalls = 0
    var operation: suspend () -> SupportFeedbackOutcome<SupportFeedbackResponse> = {
        success()
    }

    override suspend fun submit(
        submissionId: String,
        category: SupportFeedbackCategory,
        rawMessage: String,
        forceGuest: Boolean,
    ): SupportFeedbackOutcome<SupportFeedbackResponse> {
        submitCalls += 1
        return operation()
    }

    fun success(): SupportFeedbackOutcome<SupportFeedbackResponse> =
        SupportFeedbackOutcome.Success(
            SupportFeedbackResponse(
                feedbackId = "11111111-1111-4111-8111-111111111111",
                accepted = true,
                retentionAfterClosureDays = 180,
            ),
        )
}
