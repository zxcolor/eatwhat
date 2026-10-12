package com.chishenme.app.feature.nearby

import com.chishenme.app.domain.LocationChoice
import com.chishenme.app.location.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class NearbyPhase { IDLE, PERMISSION, LOCATING, COLLECTING, DONE, FAILED }
data class NearbyCollectionState(
    val phase: NearbyPhase = NearbyPhase.IDLE,
    val attempt: Int = 0,
    val count: Int = 0,
    val failure: LocationFailure? = null,
    val message: String? = null,
    val location: LocationChoice? = null,
    val limited: Boolean = false,
)

/** One attempt sequence per foreground opening; survives Compose recreation. */
internal class NearbyCollectionController(
    private val scope: CoroutineScope,
    private val locationClient: ForegroundLocationClient,
    private val accepted: suspend () -> Boolean,
    private val collect: suspend (LocationChoice, Long, (Int) -> Unit) -> Boolean,
) {
    private val mutableState = MutableStateFlow(NearbyCollectionState())
    val state = mutableState.asStateFlow()
    private var foreground = false
    private var enabled = false
    private var attempted = false
    private var firstOpening = true
    private var startedAtMillis = 0L
    private var job: Job? = null

    fun open(launchTimestamp: Long) {
        if (foreground) return
        foreground = true
        if (mutableState.value.phase != NearbyPhase.PERMISSION) {
            val timestamp = if (firstOpening) launchTimestamp else System.currentTimeMillis()
            startedAtMillis = maxOf(timestamp, startedAtMillis + 1)
            firstOpening = false
            attempted = false
            mutableState.value = NearbyCollectionState()
        }
    }

    fun configure(available: Boolean, permissionGranted: Boolean) {
        enabled = available
        if (!available) {
            job?.cancel()
            job = null
            if (mutableState.value.phase == NearbyPhase.COLLECTING) {
                // Configuration refresh cancels an in-flight page, but does
                // not silently start another two-page collection this opening.
                mutableState.value = mutableState.value.copy(phase = NearbyPhase.DONE)
            } else if (mutableState.value.phase == NearbyPhase.LOCATING || mutableState.value.phase == NearbyPhase.PERMISSION) {
                attempted = false
                mutableState.value = NearbyCollectionState()
            }
            return
        }
        if (foreground && mutableState.value.phase == NearbyPhase.PERMISSION && permissionGranted) {
            locate()
            return
        }
        if (!foreground || attempted) return
        attempted = true
        if (permissionGranted) locate() else mutableState.value = NearbyCollectionState(NearbyPhase.PERMISSION)
    }

    fun permissionResult(granted: Boolean, permanent: Boolean = false) {
        if (!foreground || !enabled || mutableState.value.phase != NearbyPhase.PERMISSION) return
        if (granted) locate() else mutableState.value = NearbyCollectionState(
            NearbyPhase.FAILED,
            failure = if (permanent) LocationFailure.PERMISSION_PERMANENTLY_DENIED else LocationFailure.PERMISSION_DENIED,
        )
    }

    fun retry(permissionGranted: Boolean) {
        if (!foreground || !enabled) return
        mutableState.value = NearbyCollectionState()
        if (permissionGranted) locate() else mutableState.value = NearbyCollectionState(NearbyPhase.PERMISSION)
    }

    fun dismissReminder() {
        mutableState.value = mutableState.value.copy(phase = NearbyPhase.DONE, failure = null, message = null)
    }

    fun stop() {
        foreground = false
        job?.cancel()
        job = null
    }

    fun clearStatus() {
        stop()
        mutableState.value = NearbyCollectionState()
    }

    private fun locate() {
        job?.cancel()
        mutableState.value = NearbyCollectionState(NearbyPhase.LOCATING)
        job = scope.launch {
            try {
                if (!accepted()) return@launch
                val result = locationWithRetries(locationClient) { attempt ->
                    mutableState.value = mutableState.value.copy(attempt = attempt)
                }
                currentCoroutineContext().ensureActive()
                if (!accepted()) return@launch
                when (result) {
                    is ForegroundLocationResult.Failure -> mutableState.value =
                        if (result.reason == LocationFailure.PERMISSION_DENIED) NearbyCollectionState(NearbyPhase.PERMISSION)
                        else NearbyCollectionState(NearbyPhase.FAILED, attempt = mutableState.value.attempt, failure = result.reason)
                    is ForegroundLocationResult.Success -> {
                        val choice = ForegroundLocationMapper.toLocationChoice(result.fix, result.access)
                        if (choice == null) {
                            mutableState.value = NearbyCollectionState(NearbyPhase.FAILED, failure = LocationFailure.UNAVAILABLE)
                            return@launch
                        }
                        mutableState.value = mutableState.value.copy(phase = NearbyPhase.COLLECTING, location = choice)
                        // Keep the reported accuracy in this local collection.
                        // The recommendation choice retains its existing API bounds.
                        val collectionChoice = choice.copy(coordinate = choice.coordinate.copy(
                            accuracyMeters = result.fix.accuracyMeters?.takeIf { it.isFinite() && it > 0.0 },
                        ))
                        val limited = collect(collectionChoice, startedAtMillis) { count ->
                            mutableState.value = mutableState.value.copy(count = count)
                        }
                        currentCoroutineContext().ensureActive()
                        mutableState.value = mutableState.value.copy(phase = NearbyPhase.DONE, limited = limited)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                mutableState.value = mutableState.value.copy(
                    phase = NearbyPhase.FAILED,
                    message = "附近餐厅暂未全部保存，已获取的数据仍保留在本次文件中。请稍后重试。",
                )
            }
        }
    }
}
