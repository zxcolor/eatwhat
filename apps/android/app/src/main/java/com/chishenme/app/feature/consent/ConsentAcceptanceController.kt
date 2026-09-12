package com.chishenme.app.feature.consent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class ConsentAcceptanceState { IDLE, SAVING, FAILED, ACCEPTED }

/** Presents the durable coordinator's outcome without reopening any privacy gate itself. */
internal class ConsentAcceptanceController(
    private val scope: CoroutineScope,
    private val accept: suspend () -> Boolean,
    private val onAccepted: () -> Unit,
) {
    private val mutableState = MutableStateFlow(ConsentAcceptanceState.IDLE)
    val state: StateFlow<ConsentAcceptanceState> = mutableState.asStateFlow()
    private var generation = 0L
    private var job: Job? = null

    fun submit() {
        if (state.value == ConsentAcceptanceState.SAVING ||
            state.value == ConsentAcceptanceState.ACCEPTED
        ) return
        val operation = ++generation
        mutableState.value = ConsentAcceptanceState.SAVING
        job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val accepted = accept()
                if (generation != operation) return@launch
                mutableState.value = if (accepted) ConsentAcceptanceState.ACCEPTED else ConsentAcceptanceState.FAILED
                if (accepted) onAccepted()
            } catch (cancelled: CancellationException) {
                if (generation == operation) mutableState.value = ConsentAcceptanceState.IDLE
                throw cancelled
            } catch (_: Exception) {
                if (generation == operation) mutableState.value = ConsentAcceptanceState.FAILED
            }
        }
    }

    fun resetForWithdrawal() {
        generation += 1
        job?.cancel()
        job = null
        mutableState.value = ConsentAcceptanceState.IDLE
    }
}
