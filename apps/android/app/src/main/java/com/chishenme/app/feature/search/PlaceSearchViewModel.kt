package com.chishenme.app.feature.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.PlaceSearchOutcome
import com.chishenme.app.data.PlaceSearchRepository
import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchKeywordValidation
import com.chishenme.app.data.remote.PlaceSearchKeywordValidator
import com.chishenme.app.data.remote.PlaceSearchRequest
import com.chishenme.app.data.remote.PlaceSearchResponse
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.domain.DecisionInput
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import com.chishenme.app.feature.session.ResultSessionState
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface PlaceSearchLoadState {
    data object Idle : PlaceSearchLoadState
    data object Loading : PlaceSearchLoadState
    data class Ready(
        val response: PlaceSearchResponse,
        /** Exact request snapshot remains only in this in-memory ViewModel. */
        val request: PlaceSearchRequest,
    ) : PlaceSearchLoadState

    data class Empty(
        val response: PlaceSearchResponse,
        val request: PlaceSearchRequest,
    ) : PlaceSearchLoadState

    data class OutsidePilot(val notice: String) : PlaceSearchLoadState
    data class Failed(val message: String) : PlaceSearchLoadState
}

data class PlaceSearchUiState(
    val keyword: String = "",
    val keywordError: String? = null,
    val openNow: Boolean = false,
    val useCurrentBudget: Boolean = true,
    val loadState: PlaceSearchLoadState = PlaceSearchLoadState.Idle,
)

/** Capability decision bound to the exact trusted remote-config generation that issued it. */
data class PlaceSearchCapabilityAuthority(
    val configurationGeneration: Long,
    val enabled: Boolean,
)

@HiltViewModel
class PlaceSearchViewModel @Inject constructor(
    private val repository: PlaceSearchRepository,
    private val runtimeAppVersionGate: RuntimeAppVersionGate,
) : ViewModel() {
    private val mutableState = MutableStateFlow(PlaceSearchUiState())
    val state: StateFlow<PlaceSearchUiState> = mutableState.asStateFlow()

    private var searchJob: Job? = null
    private var searchGeneration = 0L
    private var lastRequest: PlaceSearchRequest? = null
    private var activeResultLease: RuntimeAppVersionGate.RemoteAccessLease? = null
    private var selectedResultToken: String? = null

    init {
        viewModelScope.launch {
            runtimeAppVersionGate.state.collect { gate ->
                if (!gate.remoteFeaturesAllowed) clearSession()
            }
        }
    }

    fun updateKeyword(value: String) {
        cancelInFlight()
        selectedResultToken = null
        val next = value.take(81)
        val error = when (val validation = PlaceSearchKeywordValidator.validate(next)) {
            is PlaceSearchKeywordValidation.Valid -> null
            is PlaceSearchKeywordValidation.Invalid -> validation.message.takeIf { next.isNotEmpty() }
        }
        mutableState.update {
            it.copy(keyword = next, keywordError = error, loadState = PlaceSearchLoadState.Idle)
        }
        lastRequest = null
    }

    fun setOpenNow(enabled: Boolean) {
        if (mutableState.value.openNow == enabled) return
        cancelAndInvalidateResults { copy(openNow = enabled, loadState = PlaceSearchLoadState.Idle) }
    }

    fun setUseCurrentBudget(enabled: Boolean) {
        if (mutableState.value.useCurrentBudget == enabled) return
        cancelAndInvalidateResults {
            copy(useCurrentBudget = enabled, loadState = PlaceSearchLoadState.Idle)
        }
    }

    fun search(input: DecisionInput, authority: PlaceSearchCapabilityAuthority?) {
        if (authority?.enabled != true) {
            cancelAndInvalidateResults {
                copy(loadState = PlaceSearchLoadState.Failed("餐厅搜索服务当前未开放，请返回首页重新连接"))
            }
            return
        }
        val accessLease = runtimeAppVersionGate.acquireRemoteAccessLease(
            authority.configurationGeneration,
        )
        if (accessLease == null) {
            cancelAndInvalidateResults {
                copy(loadState = PlaceSearchLoadState.Failed("远程配置尚未通过当前版本兼容性校验"))
            }
            return
        }
        val location = input.location
        if (location == null) {
            cancelAndInvalidateResults {
                copy(loadState = PlaceSearchLoadState.Failed("请先返回首页定位或手动选择地点"))
            }
            return
        }
        val normalizedKeyword = when (
            val validation = PlaceSearchKeywordValidator.validate(mutableState.value.keyword)
        ) {
            is PlaceSearchKeywordValidation.Valid -> validation.normalizedKeyword
            is PlaceSearchKeywordValidation.Invalid -> {
                cancelAndInvalidateResults {
                    copy(keywordError = validation.message, loadState = PlaceSearchLoadState.Idle)
                }
                return
            }
        }
        val request = PlaceSearchRequest(
            location = PlaceSearchCoordinate(
                latitude = location.coordinate.latitude,
                longitude = location.coordinate.longitude,
                crs = location.coordinate.crs,
            ),
            mealPeriod = input.mealPeriod,
            keyword = normalizedKeyword,
            radiusMeters = normalizedPlaceSearchRadius(input.radiusMeters),
            maxAverageCostYuan = input.budgetMaxYuan.takeIf {
                mutableState.value.useCurrentBudget
            },
            openNow = mutableState.value.openNow,
            limit = 10,
        )
        lastRequest = request
        runSearch(request, accessLease)
    }

    fun retry(authority: PlaceSearchCapabilityAuthority?) {
        if (authority?.enabled != true) {
            cancelAndInvalidateResults {
                copy(loadState = PlaceSearchLoadState.Failed("餐厅搜索服务当前未开放，请返回首页重新连接"))
            }
            return
        }
        val accessLease = runtimeAppVersionGate.acquireRemoteAccessLease(
            authority.configurationGeneration,
        ) ?: return
        lastRequest?.let { runSearch(it, accessLease) }
    }

    /**
     * Cancels transport work and invalidates late responses without persisting
     * or serializing the current query/result session. A completed in-memory
     * result session remains valid when the search screen is disposed while
     * navigating to its detail screen.
     */
    fun cancelInFlight() {
        val wasLoading = mutableState.value.loadState == PlaceSearchLoadState.Loading
        searchGeneration++
        searchJob?.cancel()
        searchJob = null
        if (wasLoading) {
            activeResultLease = null
            selectedResultToken = null
        }
        mutableState.update { state ->
            if (state.loadState == PlaceSearchLoadState.Loading) {
                state.copy(loadState = PlaceSearchLoadState.Idle)
            } else {
                state
            }
        }
    }

    fun clearSession() {
        searchGeneration++
        searchJob?.cancel()
        searchJob = null
        lastRequest = null
        activeResultLease = null
        selectedResultToken = null
        mutableState.value = PlaceSearchUiState()
    }

    internal fun resultSessionState(resultToken: String): ResultSessionState {
        val ready = mutableState.value.loadState as? PlaceSearchLoadState.Ready
            ?: return ResultSessionState.EXPIRED
        val lease = activeResultLease ?: return ResultSessionState.EXPIRED
        return if (
            runtimeAppVersionGate.isRemoteAccessCurrent(lease) &&
            ready.response.results.any { it.resultToken == resultToken }
        ) {
            ResultSessionState.CURRENT
        } else {
            ResultSessionState.EXPIRED
        }
    }

    fun selectResultForDetail(resultToken: String): Boolean {
        if (resultSessionState(resultToken) != ResultSessionState.CURRENT) return false
        val ready = mutableState.value.loadState as? PlaceSearchLoadState.Ready ?: return false
        if (ready.response.results.none { it.resultToken == resultToken }) return false
        selectedResultToken = resultToken
        return true
    }

    fun selectedResultForDetail(): PlaceSearchResult? {
        val resultToken = selectedResultToken ?: return null
        if (resultSessionState(resultToken) != ResultSessionState.CURRENT) {
            selectedResultToken = null
            return null
        }
        val ready = mutableState.value.loadState as? PlaceSearchLoadState.Ready ?: return null
        return ready.response.results.firstOrNull { it.resultToken == resultToken }
            ?: run {
                selectedResultToken = null
                null
            }
    }

    fun clearSelectedResult() {
        selectedResultToken = null
    }

    private fun runSearch(
        request: PlaceSearchRequest,
        accessLease: RuntimeAppVersionGate.RemoteAccessLease,
    ) {
        if (!runtimeAppVersionGate.isRemoteAccessCurrent(accessLease)) return
        val generation = ++searchGeneration
        searchJob?.cancel()
        activeResultLease = null
        selectedResultToken = null
        mutableState.update {
            it.copy(
                keyword = request.keyword,
                keywordError = null,
                loadState = PlaceSearchLoadState.Loading,
            )
        }
        searchJob = viewModelScope.launch {
            val outcome = repository.search(request)
            currentCoroutineContext().ensureActive()
            if (
                generation != searchGeneration ||
                !runtimeAppVersionGate.isRemoteAccessCurrent(accessLease)
            ) return@launch
            activeResultLease = accessLease
            mutableState.update { state ->
                state.copy(
                    loadState = when (outcome) {
                        is PlaceSearchOutcome.Success -> PlaceSearchLoadState.Ready(
                            outcome.response,
                            request,
                        )
                        is PlaceSearchOutcome.Empty -> PlaceSearchLoadState.Empty(
                            outcome.response,
                            request,
                        )
                        is PlaceSearchOutcome.OutsidePilot -> PlaceSearchLoadState.OutsidePilot(
                            outcome.response.notice
                                ?: "当前位置不在北京四环试点区，请返回首页选择试点区内地点",
                        )
                        is PlaceSearchOutcome.Failure -> PlaceSearchLoadState.Failed(outcome.message)
                    },
                )
            }
        }
    }

    private fun cancelAndInvalidateResults(transform: PlaceSearchUiState.() -> PlaceSearchUiState) {
        searchGeneration++
        searchJob?.cancel()
        searchJob = null
        lastRequest = null
        activeResultLease = null
        selectedResultToken = null
        mutableState.update { state -> state.transform() }
    }
}

internal fun normalizedPlaceSearchRadius(value: Int): Int = value.coerceIn(500, 5_000)
