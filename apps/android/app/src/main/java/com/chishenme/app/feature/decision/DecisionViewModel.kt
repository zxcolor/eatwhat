package com.chishenme.app.feature.decision

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.LocationSearchOutcome
import com.chishenme.app.data.LocationSearchRepository
import com.chishenme.app.data.FeatureConfigOutcome
import com.chishenme.app.data.RecommendationOutcome
import com.chishenme.app.data.RecommendationRepository
import com.chishenme.app.data.local.AppPreferences
import com.chishenme.app.data.local.DecisionHistoryStore
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.PublicRecommendationDefaults
import com.chishenme.app.data.remote.LocationSearchDataMode
import com.chishenme.app.data.remote.LocationSearchPlace
import com.chishenme.app.data.remote.LocationSearchQueryValidation
import com.chishenme.app.data.remote.LocationSearchQueryValidator
import com.chishenme.app.data.remote.RecommendationEventType
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.RecommendationTarget
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.data.remote.UserReportedWeatherPreference
import com.chishenme.app.data.remote.WeatherContextKind
import com.chishenme.app.data.remote.WeatherContextRequest
import com.chishenme.app.data.remote.effectiveServiceCapabilities
import com.chishenme.app.data.remote.effectiveSpecialtyCapabilities
import com.chishenme.app.domain.DecisionInput
import com.chishenme.app.domain.DecisionInputValidator
import com.chishenme.app.domain.DecisionScenario
import com.chishenme.app.domain.InputValidation
import com.chishenme.app.domain.LocationChoice
import com.chishenme.app.domain.LocationSearchSelectionMapper
import com.chishenme.app.domain.RecommendationRequestFactory
import com.chishenme.app.domain.RecommendationRadiusPolicy
import com.chishenme.app.domain.applyScenario
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import com.chishenme.app.feature.config.configOrNull
import com.chishenme.app.feature.session.ResultSessionState
import com.chishenme.app.location.ForegroundLocationClient
import com.chishenme.app.location.ForegroundLocationMapper
import com.chishenme.app.location.ForegroundLocationResult
import com.chishenme.app.location.LocationFailure
import com.chishenme.app.location.LocationUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface RecommendationLoadState {
    data object Idle : RecommendationLoadState
    data object Loading : RecommendationLoadState
    data class Ready(
        val response: RecommendationResponse,
        /** Exact in-memory request snapshot used for this response; never persisted. */
        val context: RecommendationContext,
        /** Remote configuration generation under which this result was requested. */
        val configurationGeneration: Long,
        /**
         * Whether the request was authorized by a trusted compatible configuration.
         * Guest rules-only results may be displayed and rerolled, but must never
         * acquire a detail/action session or emit recommendation events.
         */
        val trustedCompatibleConfiguration: Boolean,
    ) : RecommendationLoadState
    data class Failed(val message: String) : RecommendationLoadState
}

sealed interface LocationSearchUiState {
    data object Idle : LocationSearchUiState
    data object Loading : LocationSearchUiState
    data class Ready(
        val dataSource: String,
        val dataMode: LocationSearchDataMode,
        val results: List<LocationSearchPlace>,
        val notice: String?,
    ) : LocationSearchUiState

    data class Empty(
        val dataSource: String,
        val dataMode: LocationSearchDataMode,
        val notice: String?,
    ) : LocationSearchUiState

    data class Failed(val message: String) : LocationSearchUiState
}

data class DecisionUiState(
    val input: DecisionInput = defaultDecisionInput(),
    val activeScenario: DecisionScenario? = null,
    val loadState: RecommendationLoadState = RecommendationLoadState.Idle,
    val formError: String? = null,
    val transientMessage: String? = null,
    val remoteFeatureConfig: RemoteFeatureConfigState = RemoteFeatureConfigState.Loading(0),
    val locationState: LocationUiState = LocationUiState.Idle,
    val locationChooserOpen: Boolean = false,
    /** In-memory only. Never put a location-search draft in SavedState or persistence. */
    val locationSearchQuery: String = "",
    val locationSearchState: LocationSearchUiState = LocationSearchUiState.Idle,
) {
    val featureConfig: FeatureConfig?
        get() = remoteFeatureConfig.configOrNull

    val radiusError: String?
        get() = RecommendationRadiusPolicy.validationMessage(
            input.radiusMeters,
            featureConfig?.recommendationDefaults,
        )
}

internal fun DecisionUiState.afterLocationRequestCancellation(): DecisionUiState =
    when (locationState) {
        LocationUiState.AwaitingPermission,
        LocationUiState.Locating -> copy(locationState = LocationUiState.Idle)
        else -> this
    }

private fun defaultDecisionInput() = DecisionInput(
    location = null,
    // Breakfast and dinner now use separately versioned server profiles. Until
    // a trusted config explicitly enables them, start from the lunch baseline.
    mealPeriod = MealPeriod.LUNCH,
    target = RecommendationTarget.MEAL,
    weatherContext = WeatherContextRequest.None,
    decisionMode = DecisionMode.QUICK,
    travelMode = TravelMode.WALK,
    explorationMode = ExplorationMode.BALANCED,
    budgetMaxYuan = 25,
    availableMinutes = 60,
    radiusMeters = 1_500,
    partySize = 1,
    excludedCuisines = emptySet(),
    preferredCuisines = emptySet(),
)

@HiltViewModel
class DecisionViewModel @Inject constructor(
    private val repository: RecommendationRepository,
    private val locationSearchRepository: LocationSearchRepository,
    private val preferences: AppPreferences,
    private val historyStore: DecisionHistoryStore,
    private val locationClient: ForegroundLocationClient,
    val runtimeAppVersionGate: RuntimeAppVersionGate,
) : ViewModel() {
    private val requestFactory = RecommendationRequestFactory()
    private val _uiState = MutableStateFlow(DecisionUiState())
    val uiState: StateFlow<DecisionUiState> = _uiState.asStateFlow()

    private var lastSubmittedInput: DecisionInput? = null
    private var recommendationJob: Job? = null
    private var recommendationEventJob: Job? = null
    private var configurationJob: Job? = null
    private var locationJob: Job? = null
    private var locationSearchJob: Job? = null
    private var configurationGeneration: Long = 0
    private var recommendationGeneration: Long = 0
    private var locationSearchGeneration: Long = 0
    private var consentSessionStarted = false
    private var selectedResultToken: String? = null
    /** Includes a user-selected scenario; survives refresh, but never privacy withdrawal. */
    private var radiusExplicitlySelected = false

    fun ensureConsentSessionStarted() {
        if (!consentSessionStarted) startConsentSession()
    }

    fun startConsentSession() {
        consentSessionStarted = true
        val generation = runtimeAppVersionGate.beginConfigurationRefresh()
        configurationGeneration = generation
        configurationJob?.cancel()
        recommendationGeneration++
        recommendationJob?.cancel()
        recommendationJob = null
        recommendationEventJob?.cancel()
        recommendationEventJob = null
        locationSearchGeneration++
        locationSearchJob?.cancel()
        locationSearchJob = null
        selectedResultToken = null
        lastSubmittedInput = null
        // A foreground refresh must revoke every remotely controlled capability
        // and every response issued under the prior configuration before network
        // work begins. Baseline location/budget constraints stay intact, while
        // versioned meal/target/weather fields reset until new authority arrives.
        _uiState.update {
            it.copy(
                input = it.input.copy(
                    mealPeriod = MealPeriod.LUNCH,
                    target = RecommendationTarget.MEAL,
                    weatherContext = WeatherContextRequest.None,
                ),
                loadState = RecommendationLoadState.Idle,
                remoteFeatureConfig = RemoteFeatureConfigState.Loading(generation),
                locationChooserOpen = false,
                locationSearchQuery = "",
                locationSearchState = LocationSearchUiState.Idle,
            )
        }
        configurationJob = viewModelScope.launch {
            val outcome = repository.featureConfig()
            if (!configurationRefreshIsCurrent(generation)) return@launch
            when (outcome) {
                is FeatureConfigOutcome.Success -> runtimeAppVersionGate.acceptTrustedConfiguration(
                    generation = generation,
                    minimumSupportedVersion = outcome.config.minimumSupportedVersion,
                )
                FeatureConfigOutcome.Unavailable ->
                    runtimeAppVersionGate.markConfigurationUnavailable(generation)
                FeatureConfigOutcome.Incompatible ->
                    runtimeAppVersionGate.markConfigurationIncompatible(generation)
            }
            // Another DecisionViewModel can begin a newer process-wide refresh
            // while this request is suspended. Gate terminal mutations already
            // reject that stale response; mirror the same authority before this
            // older ViewModel writes any local UI state.
            if (!configurationRefreshIsCurrent(generation)) return@launch
            if (
                runtimeAppVersionGate.currentState.status ==
                RuntimeAppVersionGate.Status.UPDATE_REQUIRED
            ) {
                revokeRemoteWorkForRequiredUpdate()
            }
            _uiState.update { state ->
                if (!configurationRefreshIsCurrent(generation)) state else when (outcome) {
                    is FeatureConfigOutcome.Success -> {
                        val gateStatus = runtimeAppVersionGate.currentState.status
                        val nextRadius = if (
                            gateStatus == RuntimeAppVersionGate.Status.COMPATIBLE &&
                            !radiusExplicitlySelected
                        ) {
                            RecommendationRadiusPolicy.automaticRadius(
                                state.input.mealPeriod,
                                outcome.config.recommendationDefaults,
                            )
                        } else state.input.radiusMeters
                        val radiusMessage = RecommendationRadiusPolicy.validationMessage(
                            nextRadius,
                            outcome.config.recommendationDefaults,
                        )
                        state.copy(
                            input = state.input.copy(radiusMeters = nextRadius),
                            remoteFeatureConfig = if (
                                gateStatus == RuntimeAppVersionGate.Status.UNKNOWN
                            ) {
                                RemoteFeatureConfigState.Incompatible(generation)
                            } else {
                                RemoteFeatureConfigState.Ready(
                                    generation = generation,
                                    config = outcome.config,
                                )
                            },
                            // A trusted compatible response is a new authority,
                            // so no error produced under an older configuration
                            // generation may remain in the restored Home UI.
                            formError = if (
                                gateStatus == RuntimeAppVersionGate.Status.COMPATIBLE
                            ) radiusMessage else state.formError,
                            transientMessage = when (gateStatus) {
                                RuntimeAppVersionGate.Status.UPDATE_REQUIRED ->
                                    requiredUpdateMessage()
                                RuntimeAppVersionGate.Status.UNKNOWN ->
                                    "服务端最低版本配置无效，远程能力已按安全默认值关闭"
                                RuntimeAppVersionGate.Status.COMPATIBLE -> when {
                                    radiusMessage != null -> radiusMessage
                                    nextRadius != state.input.radiusMeters ->
                                        "已按当前服务建议将最远距离调整为 $nextRadius 米。"
                                    else -> null
                                }
                            },
                        )
                    }
                    FeatureConfigOutcome.Unavailable -> state.copy(
                            remoteFeatureConfig = RemoteFeatureConfigState.Unavailable(generation),
                            transientMessage = if (runtimeAppVersionGate.currentState.status ==
                                RuntimeAppVersionGate.Status.UPDATE_REQUIRED
                            ) requiredUpdateMessage()
                            else "远程配置暂不可用，AI 已按安全默认值关闭",
                        )
                    FeatureConfigOutcome.Incompatible -> state.copy(
                            remoteFeatureConfig = RemoteFeatureConfigState.Incompatible(generation),
                            transientMessage = if (runtimeAppVersionGate.currentState.status ==
                                RuntimeAppVersionGate.Status.UPDATE_REQUIRED
                            ) requiredUpdateMessage()
                            else "当前 App 与服务版本不兼容，请更新 App；AI 已按安全默认值关闭",
                        )
                }
            }
        }
    }

    private fun configurationRefreshIsCurrent(generation: Long): Boolean =
        generation == configurationGeneration &&
            runtimeAppVersionGate.currentState.observedConfigurationGeneration == generation

    fun setDecisionMode(value: DecisionMode) = updateInput { copy(decisionMode = value) }

    fun applyScenario(value: DecisionScenario) {
        radiusExplicitlySelected = true
        _uiState.update { state ->
            val input = state.input.applyScenario(value)
            state.copy(
                input = input,
                activeScenario = value,
                formError = RecommendationRadiusPolicy.validationMessage(
                    input.radiusMeters,
                    trustedRecommendationDefaults(),
                ),
            )
        }
    }

    fun setMealPeriod(value: MealPeriod) {
        val enabled = when (value) {
            MealPeriod.LUNCH -> true
            MealPeriod.BREAKFAST ->
                trustedSpecialtyCapabilities()?.breakfastProfileEnabled == true
            MealPeriod.DINNER ->
                trustedSpecialtyCapabilities()?.dinnerProfileEnabled == true
        }
        if (!enabled) {
            _uiState.update {
                it.copy(formError = "该餐段专项当前未开放，请先选择午餐")
            }
            return
        }
        updateInput {
            copy(
                mealPeriod = value,
                radiusMeters = if (radiusExplicitlySelected) radiusMeters else
                    RecommendationRadiusPolicy.automaticRadius(value, trustedRecommendationDefaults()),
            )
        }
    }

    fun setRecommendationTarget(value: RecommendationTarget) {
        if (value == RecommendationTarget.MEAL) {
            updateInput { copy(target = value) }
            return
        }
        val enabled = trustedSpecialtyCapabilities()?.enables(value) == true
        if (!enabled) {
            _uiState.update {
                it.copy(formError = "该专项推荐当前未开放，请先使用普通用餐模式")
            }
            return
        }
        updateInput { copy(target = value) }
    }

    fun setUserReportedWeather(value: UserReportedWeatherPreference?) {
        if (value == null) {
            updateInput { copy(weatherContext = WeatherContextRequest.None) }
            return
        }
        if (trustedSpecialtyCapabilities()?.userReportedWeatherEnabled != true) {
            _uiState.update {
                it.copy(formError = "手动体感推荐当前未开放")
            }
            return
        }
        updateInput {
            copy(
                weatherContext = WeatherContextRequest(
                    kind = WeatherContextKind.USER_REPORTED,
                    preference = value,
                ),
            )
        }
    }

    fun setBudget(value: Int?) = updateInput { copy(budgetMaxYuan = value) }
    fun setAvailableMinutes(value: Int) = updateInput { copy(availableMinutes = value) }
    fun setRadius(value: Int) {
        radiusExplicitlySelected = true
        updateInput { copy(radiusMeters = value) }
    }
    fun setTravelMode(value: TravelMode) = updateInput { copy(travelMode = value) }
    fun setExplorationMode(value: ExplorationMode) = updateInput { copy(explorationMode = value) }
    fun setLocation(value: LocationChoice) {
        dismissLocationSearch()
        locationJob?.cancel()
        locationJob = null
        _uiState.update { state ->
            state.copy(
                input = state.input.copy(location = value),
                locationState = LocationUiState.Idle,
                formError = null,
            )
        }
    }
    fun setPartySize(value: Int) = updateInput { copy(partySize = value.coerceIn(1, 30)) }

    fun toggleCuisine(cuisine: String, preferred: Boolean) = updateInput {
        if (preferred) {
            val next = preferredCuisines.toMutableSet().apply {
                if (!add(cuisine)) remove(cuisine)
            }
            copy(preferredCuisines = next, excludedCuisines = excludedCuisines - cuisine)
        } else {
            val next = excludedCuisines.toMutableSet().apply {
                if (!add(cuisine)) remove(cuisine)
            }
            copy(excludedCuisines = next, preferredCuisines = preferredCuisines - cuisine)
        }
    }

    fun showMessage(message: String) {
        _uiState.update { it.copy(transientMessage = message) }
    }

    fun consumeMessage() {
        _uiState.update { it.copy(transientMessage = null) }
    }

    fun onLocationPermissionRequestStarted() {
        locationJob?.cancel()
        locationJob = null
        _uiState.update {
            it.copy(
                locationState = LocationUiState.AwaitingPermission,
                formError = null,
            )
        }
    }

    fun onLocationPermissionDenied(permanentlyDenied: Boolean) {
        locationJob?.cancel()
        locationJob = null
        _uiState.update {
            it.copy(
                locationState = LocationUiState.Failed(
                    if (permanentlyDenied) {
                        LocationFailure.PERMISSION_PERMANENTLY_DENIED
                    } else {
                        LocationFailure.PERMISSION_DENIED
                    },
                ),
            )
        }
    }

    fun locate() {
        locationJob?.cancel()
        _uiState.update {
            it.copy(
                locationState = LocationUiState.Locating,
                formError = null,
            )
        }
        locationJob = viewModelScope.launch {
            when (val result = locationClient.currentLocation()) {
                is ForegroundLocationResult.Success -> {
                    val choice = ForegroundLocationMapper.toLocationChoice(result.fix, result.access)
                    if (choice == null) {
                        _uiState.update {
                            it.copy(locationState = LocationUiState.Failed(LocationFailure.UNAVAILABLE))
                        }
                    } else {
                        _uiState.update { state ->
                            state.copy(
                                input = state.input.copy(location = choice),
                                locationState = LocationUiState.Ready(
                                    access = result.access,
                                    accuracyMeters = choice.coordinate.accuracyMeters,
                                ),
                                formError = null,
                            )
                        }
                    }
                }
                is ForegroundLocationResult.Failure -> {
                    _uiState.update { it.copy(locationState = LocationUiState.Failed(result.reason)) }
                }
            }
        }
    }

    /** Cancels only the foreground location task; recommendation work and data stay intact. */
    fun cancelLocationRequest() {
        locationJob?.cancel()
        locationJob = null
        _uiState.update(DecisionUiState::afterLocationRequestCancellation)
    }

    fun openLocationChooser() {
        _uiState.update { it.copy(locationChooserOpen = true) }
    }

    fun updateLocationSearchQuery(value: String) {
        val next = value.take(81)
        if (_uiState.value.locationSearchQuery == next) return
        cancelLocationSearch()
        _uiState.update { it.copy(locationSearchQuery = next) }
    }

    fun searchLocation() {
        val query = _uiState.value.locationSearchQuery
        val normalizedQuery = when (val validation = LocationSearchQueryValidator.validate(query)) {
            is LocationSearchQueryValidation.Valid -> validation.normalizedQuery
            is LocationSearchQueryValidation.Invalid -> {
                locationSearchGeneration++
                locationSearchJob?.cancel()
                locationSearchJob = null
                _uiState.update {
                    it.copy(locationSearchState = LocationSearchUiState.Failed(validation.message))
                }
                return
            }
        }

        val accessLease = currentRemoteAccessLease()
        if (accessLease == null) {
            cancelLocationSearch()
            _uiState.update {
                it.copy(locationSearchState = LocationSearchUiState.Failed(remoteAccessBlockedMessage()))
            }
            return
        }
        if (_uiState.value.featureConfig?.effectiveServiceCapabilities()?.locationSearchEnabled != true) {
            cancelLocationSearch()
            _uiState.update {
                it.copy(locationSearchState = LocationSearchUiState.Failed("地点搜索服务当前未开放，请重新连接后再试"))
            }
            return
        }

        val generation = ++locationSearchGeneration
        locationSearchJob?.cancel()
        _uiState.update { it.copy(locationSearchState = LocationSearchUiState.Loading) }
        locationSearchJob = viewModelScope.launch {
            val outcome = locationSearchRepository.search(normalizedQuery)
            currentCoroutineContext().ensureActive()
            if (
                generation != locationSearchGeneration ||
                !runtimeAppVersionGate.isRemoteAccessCurrent(accessLease)
            ) return@launch

            _uiState.update { state ->
                state.copy(
                    locationSearchState = when (outcome) {
                        is LocationSearchOutcome.Success -> LocationSearchUiState.Ready(
                            dataSource = outcome.dataSource,
                            dataMode = outcome.dataMode,
                            results = outcome.results,
                            notice = outcome.notice,
                        )
                        is LocationSearchOutcome.Empty -> LocationSearchUiState.Empty(
                            dataSource = outcome.dataSource,
                            dataMode = outcome.dataMode,
                            notice = outcome.notice,
                        )
                        is LocationSearchOutcome.Failure -> LocationSearchUiState.Failed(outcome.message)
                    },
                )
            }
        }
    }

    /** Cancels remote work and clears results while preserving the in-memory editing draft. */
    fun cancelLocationSearch() {
        locationSearchGeneration++
        locationSearchJob?.cancel()
        locationSearchJob = null
        _uiState.update { state ->
            if (state.locationSearchState == LocationSearchUiState.Idle) state
            else state.copy(locationSearchState = LocationSearchUiState.Idle)
        }
    }

    /** Clears the complete ephemeral chooser session and rejects every late response. */
    fun dismissLocationSearch() {
        cancelLocationSearch()
        _uiState.update { state ->
            if (!state.locationChooserOpen && state.locationSearchQuery.isEmpty()) state
            else state.copy(locationChooserOpen = false, locationSearchQuery = "")
        }
    }

    fun selectLocationSearchResult(
        place: LocationSearchPlace,
        dataMode: LocationSearchDataMode,
    ) {
        setLocation(LocationSearchSelectionMapper.toLocationChoice(place, dataMode))
    }

    fun recommend(): Boolean {
        val input = _uiState.value.input
        return when (val validation = DecisionInputValidator.validate(input)) {
            is InputValidation.Invalid -> {
                _uiState.update { it.copy(formError = validation.message) }
                false
            }
            InputValidation.Valid -> {
                val started = runRecommendation(input)
                if (started) lastSubmittedInput = input
                started
            }
        }
    }

    fun retry() {
        (lastSubmittedInput ?: _uiState.value.input).let(::runRecommendation)
    }

    fun reroll() {
        val current = (_uiState.value.loadState as? RecommendationLoadState.Ready)?.response
        current?.results?.firstOrNull()?.let { first ->
            recordEvent(first, RecommendationEventType.REROLL)
        }
        retry()
    }

    fun recordEvent(result: RecommendationResult, type: RecommendationEventType) {
        if (recommendationSessionState(result.resultToken) != ResultSessionState.CURRENT) return
        val ready = _uiState.value.loadState as? RecommendationLoadState.Ready ?: return
        if (!ready.trustedCompatibleConfiguration) return
        val response = ready.response
        // Tokens are request-scoped. Never pair a result retained by the UI with
        // a newer response's request ID after a retry or reroll.
        if (response.results.none { it.resultToken == result.resultToken }) return
        val accessLease = runtimeAppVersionGate.acquireRemoteAccessLease(
            (_uiState.value.remoteFeatureConfig as? RemoteFeatureConfigState.Ready)?.generation
                ?: return,
        ) ?: return
        val generation = recommendationGeneration
        recommendationEventJob?.cancel()
        recommendationEventJob = viewModelScope.launch {
            if (
                generation != recommendationGeneration ||
                !runtimeAppVersionGate.isRemoteAccessCurrent(accessLease)
            ) return@launch
            repository.recordEvent(
                requestId = response.requestId,
                resultToken = result.resultToken,
                type = type,
            )
        }
    }

    fun clearForPrivacyWithdrawal() {
        viewModelScope.coroutineContext.cancelChildren()
        recommendationJob = null
        recommendationEventJob = null
        configurationJob = null
        locationJob = null
        locationSearchJob = null
        configurationGeneration = runtimeAppVersionGate.beginConfigurationRefresh()
        recommendationGeneration++
        locationSearchGeneration++
        consentSessionStarted = false
        selectedResultToken = null
        lastSubmittedInput = null
        radiusExplicitlySelected = false
        _uiState.value = DecisionUiState()
    }

    private fun runRecommendation(input: DecisionInput): Boolean {
        val accessLease = currentRecommendationAccessLease()
        if (accessLease == null) {
            _uiState.update { it.copy(loadState = RecommendationLoadState.Idle, formError = remoteAccessBlockedMessage()) }
            return false
        }
        val radiusError = RecommendationRadiusPolicy.validationMessage(
            input.radiusMeters,
            trustedRecommendationDefaults(),
        )
        if (radiusError != null) {
            _uiState.update {
                it.copy(loadState = RecommendationLoadState.Idle, formError = radiusError)
            }
            return false
        }
        if (
            accessLease.trustedCompatibleConfiguration &&
            _uiState.value.featureConfig?.effectiveServiceCapabilities()?.recommendationsEnabled != true
        ) {
            _uiState.update {
                it.copy(
                    loadState = RecommendationLoadState.Idle,
                    formError = "餐厅推荐服务当前未开放，请重新连接后再试",
                )
            }
            return false
        }
        if (!specialtyInputAuthorized(input, accessLease.trustedCompatibleConfiguration)) {
            _uiState.update {
                it.copy(
                    loadState = RecommendationLoadState.Idle,
                    formError = "专项推荐能力已关闭，请重新选择普通用餐模式",
                )
            }
            return false
        }
        val generation = ++recommendationGeneration
        val requestConfigurationGeneration = accessLease.configurationGeneration
        recommendationJob?.cancel()
        selectedResultToken = null
        _uiState.update { it.copy(loadState = RecommendationLoadState.Loading, formError = null) }
        recommendationJob = viewModelScope.launch {
            val aiAssistanceEnabled =
                preferences.aiAssistanceEnabled.first() && _uiState.value.featureConfig?.aiEnabled == true
            val preferenceVector = preferences.recommendationPreferenceVector.first()
            val request = requestFactory.create(input, aiAssistanceEnabled, preferenceVector)
            when (val outcome = repository.recommend(request)) {
                is RecommendationOutcome.Success -> {
                    currentCoroutineContext().ensureActive()
                    if (!recommendationAccessIsCurrent(generation, accessLease)) return@launch
                    _uiState.update {
                        it.copy(
                            loadState = RecommendationLoadState.Ready(
                                response = outcome.response,
                                context = request,
                                configurationGeneration = requestConfigurationGeneration,
                                trustedCompatibleConfiguration =
                                    accessLease.trustedCompatibleConfiguration,
                            ),
                        )
                    }
                    try {
                        if (!recommendationAccessIsCurrent(generation, accessLease)) return@launch
                        // The store accepts only DecisionInput plus a count, so neither
                        // live nor demonstration provider fields can enter local history.
                        historyStore.recordDecision(input, outcome.response.results.size)
                    } catch (_: IOException) {
                        if (!recommendationAccessIsCurrent(generation, accessLease)) return@launch
                        _uiState.update {
                            it.copy(transientMessage = "推荐完成，但最近决策暂未保存到本机")
                        }
                    }
                    // The unavailable-config lease exists only so a guest can
                    // still obtain a rules-only display. It is not authority to
                    // send even an automatic impression event.
                    if (accessLease.trustedCompatibleConfiguration) {
                        outcome.response.results.forEach { result ->
                            currentCoroutineContext().ensureActive()
                            if (!recommendationAccessIsCurrent(generation, accessLease)) return@launch
                            repository.recordEvent(
                                requestId = outcome.response.requestId,
                                resultToken = result.resultToken,
                                type = RecommendationEventType.IMPRESSION,
                            )
                        }
                    }
                }
                is RecommendationOutcome.Failure -> {
                    currentCoroutineContext().ensureActive()
                    if (!recommendationAccessIsCurrent(generation, accessLease)) return@launch
                    _uiState.update { it.copy(loadState = RecommendationLoadState.Failed(outcome.message)) }
                }
            }
        }
        return true
    }

    internal fun recommendationSessionState(resultToken: String): ResultSessionState {
        val state = _uiState.value
        if (runtimeAppVersionGate.currentState.status == RuntimeAppVersionGate.Status.UPDATE_REQUIRED) {
            return ResultSessionState.EXPIRED
        }
        val activeConfigurationGeneration = when (val remote = state.remoteFeatureConfig) {
            is RemoteFeatureConfigState.Loading -> return ResultSessionState.CONFIG_UNCONFIRMED
            is RemoteFeatureConfigState.Ready -> remote.generation
            is RemoteFeatureConfigState.Unavailable,
            is RemoteFeatureConfigState.Incompatible -> return ResultSessionState.EXPIRED
        }
        val ready = state.loadState as? RecommendationLoadState.Ready
            ?: return ResultSessionState.EXPIRED
        // Defense in depth: a guest recommendation is a display-only response,
        // even if a future UI accidentally attempts to select one of its tokens.
        if (!ready.trustedCompatibleConfiguration) return ResultSessionState.EXPIRED
        val accessLease = runtimeAppVersionGate.acquireRemoteAccessLease(activeConfigurationGeneration)
            ?: return ResultSessionState.EXPIRED
        return if (
            ready.configurationGeneration == activeConfigurationGeneration &&
            runtimeAppVersionGate.isRemoteAccessCurrent(accessLease) &&
            ready.response.results.any { it.resultToken == resultToken }
        ) {
            ResultSessionState.CURRENT
        } else {
            ResultSessionState.EXPIRED
        }
    }

    fun selectResultForDetail(resultToken: String): Boolean {
        if (recommendationSessionState(resultToken) != ResultSessionState.CURRENT) return false
        val ready = _uiState.value.loadState as? RecommendationLoadState.Ready ?: return false
        if (ready.response.results.none { it.resultToken == resultToken }) return false
        selectedResultToken = resultToken
        return true
    }

    fun selectedResultForDetail(): RecommendationResult? {
        val resultToken = selectedResultToken ?: return null
        if (recommendationSessionState(resultToken) != ResultSessionState.CURRENT) {
            selectedResultToken = null
            return null
        }
        val ready = _uiState.value.loadState as? RecommendationLoadState.Ready ?: return null
        return ready.response.results.firstOrNull { it.resultToken == resultToken }
            ?: run {
                selectedResultToken = null
                null
            }
    }

    fun clearSelectedResult() {
        selectedResultToken = null
    }

    private fun updateInput(transform: DecisionInput.() -> DecisionInput) {
        _uiState.update { state ->
            state.copy(
                input = state.input.transform(),
                activeScenario = null,
                formError = null,
            )
        }
    }

    private fun currentRemoteAccessLease(): RuntimeAppVersionGate.RemoteAccessLease? {
        val ready = _uiState.value.remoteFeatureConfig as? RemoteFeatureConfigState.Ready ?: return null
        return runtimeAppVersionGate.acquireRemoteAccessLease(ready.generation)
    }

    private fun trustedSpecialtyCapabilities() =
        (_uiState.value.remoteFeatureConfig as? RemoteFeatureConfigState.Ready)
            ?.takeIf { ready ->
                runtimeAppVersionGate.acquireRemoteAccessLease(ready.generation) != null
            }
            ?.config
            ?.effectiveSpecialtyCapabilities()

    private fun trustedRecommendationDefaults(): PublicRecommendationDefaults? =
        (_uiState.value.remoteFeatureConfig as? RemoteFeatureConfigState.Ready)
            ?.takeIf { ready ->
                runtimeAppVersionGate.acquireRemoteAccessLease(ready.generation) != null
            }
            ?.config
            ?.recommendationDefaults

    private fun specialtyInputAuthorized(
        input: DecisionInput,
        trustedCompatibleConfiguration: Boolean,
    ): Boolean {
        val usesSpecialtyTarget = input.target != RecommendationTarget.MEAL
        val usesSpecialtyMealProfile = input.mealPeriod != MealPeriod.LUNCH
        val usesUserReportedWeather = input.weatherContext.kind == WeatherContextKind.USER_REPORTED
        if (!usesSpecialtyTarget && !usesSpecialtyMealProfile && !usesUserReportedWeather) return true
        if (!trustedCompatibleConfiguration) return false
        val capabilities = trustedSpecialtyCapabilities() ?: return false
        val mealProfileEnabled = when (input.mealPeriod) {
            MealPeriod.BREAKFAST -> capabilities.breakfastProfileEnabled
            MealPeriod.LUNCH -> true
            MealPeriod.DINNER -> capabilities.dinnerProfileEnabled
        }
        return mealProfileEnabled &&
            capabilities.enables(input.target) &&
            (!usesUserReportedWeather || capabilities.userReportedWeatherEnabled)
    }

    private fun recommendationAccessIsCurrent(
        generation: Long,
        lease: RuntimeAppVersionGate.RecommendationAccessLease,
    ): Boolean = generation == recommendationGeneration &&
        runtimeAppVersionGate.isRecommendationAccessCurrent(lease) &&
        when (val remote = _uiState.value.remoteFeatureConfig) {
            is RemoteFeatureConfigState.Ready -> remote.generation == lease.configurationGeneration &&
                lease.trustedCompatibleConfiguration
            is RemoteFeatureConfigState.Unavailable ->
                remote.generation == lease.configurationGeneration &&
                    !lease.trustedCompatibleConfiguration
            is RemoteFeatureConfigState.Loading,
            is RemoteFeatureConfigState.Incompatible,
            -> false
        }

    private fun currentRecommendationAccessLease(): RuntimeAppVersionGate.RecommendationAccessLease? {
        val generation = when (val remote = _uiState.value.remoteFeatureConfig) {
            is RemoteFeatureConfigState.Ready -> remote.generation
            is RemoteFeatureConfigState.Unavailable -> remote.generation
            is RemoteFeatureConfigState.Loading,
            is RemoteFeatureConfigState.Incompatible,
            -> return null
        }
        return runtimeAppVersionGate.acquireRecommendationAccessLease(generation)
    }

    private fun revokeRemoteWorkForRequiredUpdate() {
        recommendationGeneration++
        recommendationJob?.cancel()
        recommendationJob = null
        recommendationEventJob?.cancel()
        recommendationEventJob = null
        locationSearchGeneration++
        locationSearchJob?.cancel()
        locationSearchJob = null
        selectedResultToken = null
        lastSubmittedInput = null
        _uiState.update {
            it.copy(
                loadState = RecommendationLoadState.Idle,
                locationChooserOpen = false,
                locationSearchQuery = "",
                locationSearchState = LocationSearchUiState.Idle,
                formError = requiredUpdateMessage(),
            )
        }
    }

    private fun remoteAccessBlockedMessage(): String =
        if (runtimeAppVersionGate.currentState.status == RuntimeAppVersionGate.Status.UPDATE_REQUIRED) {
            requiredUpdateMessage()
        } else {
            "远程配置尚未完成可信校验，请重新检查后再试"
        }

    private fun requiredUpdateMessage(): String {
        val minimum = runtimeAppVersionGate.currentState.minimumSupportedVersion
        return if (minimum == null) "当前版本过低，请更新后再试"
        else "当前版本过低，请更新到 $minimum 或更高版本"
    }
}
