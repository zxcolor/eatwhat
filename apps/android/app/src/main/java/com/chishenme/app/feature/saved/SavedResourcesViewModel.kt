package com.chishenme.app.feature.saved

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.AuthOutcome
import com.chishenme.app.data.AuthRepository
import com.chishenme.app.data.SavedResourcesFailureKind
import com.chishenme.app.data.SavedResourcesOutcome
import com.chishenme.app.data.SavedResourcesRepository
import com.chishenme.app.data.remote.FavoriteGroup
import com.chishenme.app.data.remote.FavoriteRecord
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.PrivateFeedbackRecord
import com.chishenme.app.data.remote.PrivateFeedbackType
import com.chishenme.app.data.remote.PersistenceCapabilities
import com.chishenme.app.data.remote.PlaceSearchResponse
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.data.remote.RecommendationHistoryItem
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.effectivePersistenceCapabilities
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class SavedResourcesSection { FAVORITES, HISTORY, PRIVATE_FEEDBACK }

internal fun enabledSavedResourceSections(
    capabilities: PersistenceCapabilities?,
): Set<SavedResourcesSection> = buildSet {
    if (capabilities?.favoritesEnabled == true) add(SavedResourcesSection.FAVORITES)
    if (capabilities?.historyEnabled == true) add(SavedResourcesSection.HISTORY)
    if (capabilities?.privateFeedbackEnabled == true) add(SavedResourcesSection.PRIVATE_FEEDBACK)
}

data class SavedResourcesUiState(
    val busy: Boolean = false,
    val message: String? = null,
    val loginRequired: Boolean = false,
    val selectedSection: SavedResourcesSection = SavedResourcesSection.FAVORITES,
    val enabledSections: Set<SavedResourcesSection> = emptySet(),
    val favorites: List<FavoriteRecord> = emptyList(),
    val history: List<RecommendationHistoryItem> = emptyList(),
    val privateFeedback: List<PrivateFeedbackRecord> = emptyList(),
    val favoritesNextCursor: String? = null,
    val historyNextCursor: String? = null,
    val feedbackNextCursor: String? = null,
    val loadedSections: Set<SavedResourcesSection> = emptySet(),
    val favoriteSaved: Boolean = false,
    val submittedFeedback: Set<PrivateFeedbackType> = emptySet(),
)

@HiltViewModel
class SavedResourcesViewModel @Inject constructor(
    private val repository: SavedResourcesRepository,
    private val authRepository: AuthRepository,
    private val runtimeAppVersionGate: RuntimeAppVersionGate,
) : ViewModel() {
    private val mutableState = MutableStateFlow(SavedResourcesUiState())
    val state: StateFlow<SavedResourcesUiState> = mutableState.asStateFlow()
    private var observedSignedInSession = false
    private var resourceGeneration = 0L
    private var resourceJob: Job? = null
    private var capabilityLease: RuntimeAppVersionGate.RemoteAccessLease? = null

    init {
        viewModelScope.launch {
            authRepository.session.collect { session ->
                if (session != null) {
                    observedSignedInSession = true
                } else if (observedSignedInSession) {
                    observedSignedInSession = false
                    invalidateResourceOperations()
                    // Never keep one account's records visible after logout or
                    // refresh-token invalidation. This is memory-only cleanup.
                    mutableState.update {
                        it.clearedAccountData(
                            loginRequired = true,
                            message = "登录状态已失效，账号记录已从当前页面清除；游客推荐不受影响",
                        )
                    }
                }
            }
        }
        viewModelScope.launch {
            runtimeAppVersionGate.state.collect {
                val lease = capabilityLease
                if (lease == null || !runtimeAppVersionGate.isRemoteAccessCurrent(lease)) {
                    revokeForRuntimeGate()
                }
            }
        }
    }

    fun start(config: FeatureConfig?, configurationGeneration: Long? = null) {
        applyCapabilitiesInternal(config, configurationGeneration)?.let(::checkSession)
    }

    /**
     * Detail destinations need revocation and write gating, but must not fetch an
     * unrelated account collection merely because a restaurant was viewed.
     * Authentication is performed only after an explicit mutation action.
     */
    fun applyCapabilities(config: FeatureConfig?, configurationGeneration: Long? = null) {
        applyCapabilitiesInternal(config, configurationGeneration)
    }

    private fun applyCapabilitiesInternal(
        config: FeatureConfig?,
        configurationGeneration: Long?,
    ): SavedResourcesSection? {
        invalidateResourceOperations()
        val lease = config?.let {
            runtimeAppVersionGate.acquireRemoteAccessLease(configurationGeneration)
        }
        capabilityLease = lease
        if (config == null || lease == null) {
            mutableState.update {
                it.withCapabilities(
                    enabled = emptySet(),
                    message = "远程配置尚未确认，账号记录能力保持关闭；本次不会上传餐厅引用",
                )
            }
            return null
        }
        val capabilities = config.effectivePersistenceCapabilities()
        val enabled = enabledSavedResourceSections(capabilities)
        if (!config.accountsEnabled || config.authCapabilities?.accountsEnabled != true) {
            mutableState.update {
                it.withCapabilities(
                    enabled = emptySet(),
                    message = "账号能力当前未开放；游客核心推荐仍可继续使用",
                )
            }
            return null
        }
        if (enabled.isEmpty()) {
            mutableState.update {
                it.withCapabilities(
                    enabled = emptySet(),
                    message = "收藏、账号历史与私有反馈当前未开放，本机最近决策不会被静默上传",
                )
            }
            return null
        }
        val firstSection = listOf(
            SavedResourcesSection.FAVORITES,
            SavedResourcesSection.HISTORY,
            SavedResourcesSection.PRIVATE_FEEDBACK,
        ).first { it in enabled }
        mutableState.update { state ->
            state.withCapabilities(enabled = enabled, message = null).copy(
                selectedSection = state.selectedSection.takeIf { it in enabled } ?: firstSection,
            )
        }
        return mutableState.value.selectedSection
    }

    fun retryLogin() {
        if (!remoteCapabilitiesCurrent() || mutableState.value.enabledSections.isEmpty() ||
            mutableState.value.busy
        ) return
        checkSession(mutableState.value.selectedSection)
    }

    private fun checkSession(section: SavedResourcesSection) {
        if (!remoteCapabilitiesCurrent() || section !in mutableState.value.enabledSections ||
            mutableState.value.busy
        ) return
        val generation = resourceGeneration
        mutableState.update { it.copy(busy = true, message = null) }
        resourceJob = viewModelScope.launch {
            when (val restored = authRepository.restoreSession()) {
                is AuthOutcome.Failure -> if (resourceAccessIsCurrent(generation)) {
                    mutableState.update {
                        it.copy(busy = false, loginRequired = true, message = restored.message)
                    }
                }
                is AuthOutcome.Success -> if (resourceAccessIsCurrent(generation)) {
                    if (restored.value == null) {
                        mutableState.update {
                            it.copy(
                                busy = false,
                                loginRequired = true,
                                message = "请先登录查看跨设备收藏、账号历史和私有反馈；本机记录不会自动上传",
                            )
                        }
                    } else {
                        mutableState.update { it.copy(busy = false, loginRequired = false) }
                        load(section, append = false, expectedGeneration = generation)
                    }
                }
            }
        }
    }

    fun select(section: SavedResourcesSection) {
        if (!remoteCapabilitiesCurrent() || section !in mutableState.value.enabledSections) return
        mutableState.update { it.copy(selectedSection = section, message = null) }
        if (section !in mutableState.value.loadedSections) load(section, append = false)
    }

    fun refresh() = load(mutableState.value.selectedSection, append = false)

    fun loadMore() = load(mutableState.value.selectedSection, append = true)

    fun createFavorite(
        config: FeatureConfig?,
        response: RecommendationResponse,
        result: RecommendationResult,
        group: FavoriteGroup,
    ) {
        when (val gate = PersistenceActionGate.evaluate(config, response, result, PersistenceCreation.FAVORITE)) {
            is PersistenceGateDecision.Blocked -> {
                mutableState.update { it.copy(message = gate.message) }
                return
            }
            PersistenceGateDecision.Allowed -> Unit
        }
        if (!requireEnabled(SavedResourcesSection.FAVORITES, "收藏能力当前未开放，本次不会上传")) return
        launchMutation(
            operation = { repository.createFavorite(response.requestId, result.resultToken, group) },
            successMessage = if (group == FavoriteGroup.WANT_TO_GO) "已收藏到“想去”" else "已收藏到“常吃”",
        ) { record ->
                copy(
                    favoriteSaved = true,
                    favorites = listOf(record) + favorites.filterNot { it.favoriteId == record.favoriteId },
                )
        }
    }

    fun createPrivateFeedback(
        config: FeatureConfig?,
        response: RecommendationResponse,
        result: RecommendationResult,
        type: PrivateFeedbackType,
    ) {
        when (
            val gate = PersistenceActionGate.evaluate(
                config,
                response,
                result,
                PersistenceCreation.PRIVATE_FEEDBACK,
            )
        ) {
            is PersistenceGateDecision.Blocked -> {
                mutableState.update { it.copy(message = gate.message) }
                return
            }
            PersistenceGateDecision.Allowed -> Unit
        }
        if (!requireEnabled(SavedResourcesSection.PRIVATE_FEEDBACK, "私有反馈能力当前未开放，本次不会上传")) {
            return
        }
        if (type in mutableState.value.submittedFeedback) return
        launchMutation(
            operation = { repository.createPrivateFeedback(response.requestId, result.resultToken, type) },
            successMessage = "私有反馈已记录，不会形成公开评分",
        ) { record ->
                copy(
                    submittedFeedback = submittedFeedback + type,
                    privateFeedback = listOf(record) + privateFeedback.filterNot {
                        it.feedbackId == record.feedbackId
                    },
                )
        }
    }

    fun createFavorite(
        config: FeatureConfig?,
        response: PlaceSearchResponse,
        result: PlaceSearchResult,
        group: FavoriteGroup,
    ) {
        when (val gate = PersistenceActionGate.evaluate(config, response, result, PersistenceCreation.FAVORITE)) {
            is PersistenceGateDecision.Blocked -> {
                mutableState.update { it.copy(message = gate.message) }
                return
            }
            PersistenceGateDecision.Allowed -> Unit
        }
        if (!requireEnabled(SavedResourcesSection.FAVORITES, "收藏能力当前未开放，本次不会上传")) return
        launchMutation(
            operation = { repository.createFavorite(response.requestId, result.resultToken, group) },
            successMessage = if (group == FavoriteGroup.WANT_TO_GO) "已收藏到“想去”" else "已收藏到“常吃”",
        ) { record ->
                copy(
                    favoriteSaved = true,
                    favorites = listOf(record) + favorites.filterNot { it.favoriteId == record.favoriteId },
                )
        }
    }

    fun createPrivateFeedback(
        config: FeatureConfig?,
        response: PlaceSearchResponse,
        result: PlaceSearchResult,
        type: PrivateFeedbackType,
    ) {
        when (
            val gate = PersistenceActionGate.evaluate(
                config,
                response,
                result,
                PersistenceCreation.PRIVATE_FEEDBACK,
            )
        ) {
            is PersistenceGateDecision.Blocked -> {
                mutableState.update { it.copy(message = gate.message) }
                return
            }
            PersistenceGateDecision.Allowed -> Unit
        }
        if (!requireEnabled(SavedResourcesSection.PRIVATE_FEEDBACK, "私有反馈能力当前未开放，本次不会上传")) {
            return
        }
        if (type in mutableState.value.submittedFeedback) return
        launchMutation(
            operation = { repository.createPrivateFeedback(response.requestId, result.resultToken, type) },
            successMessage = "私有反馈已记录，不会形成公开评分",
        ) { record ->
                copy(
                    submittedFeedback = submittedFeedback + type,
                    privateFeedback = listOf(record) + privateFeedback.filterNot {
                        it.feedbackId == record.feedbackId
                    },
                )
        }
    }

    fun updateFavoriteGroup(record: FavoriteRecord) = mutateUnitLike(
        requiredSection = SavedResourcesSection.FAVORITES,
        operation = {
            repository.updateFavoriteGroup(
                record.favoriteId,
                if (record.group == FavoriteGroup.WANT_TO_GO) FavoriteGroup.REGULAR else FavoriteGroup.WANT_TO_GO,
            )
        },
        successMessage = "收藏分组已更新",
    ) { updated ->
        copy(favorites = favorites.map { if (it.favoriteId == updated.favoriteId) updated else it })
    }

    fun deleteFavorite(record: FavoriteRecord) = mutateUnit(
        requiredSection = SavedResourcesSection.FAVORITES,
        operation = { repository.deleteFavorite(record.favoriteId) },
        successMessage = "收藏已删除",
    ) { copy(favorites = favorites.filterNot { it.favoriteId == record.favoriteId }) }

    fun deletePrivateFeedback(record: PrivateFeedbackRecord) = mutateUnit(
        requiredSection = SavedResourcesSection.PRIVATE_FEEDBACK,
        operation = { repository.deletePrivateFeedback(record.feedbackId) },
        successMessage = "私有反馈已删除",
    ) { copy(privateFeedback = privateFeedback.filterNot { it.feedbackId == record.feedbackId }) }

    fun clearHistory() = mutateUnit(
        requiredSection = SavedResourcesSection.HISTORY,
        operation = repository::clearHistory,
        successMessage = "账号推荐历史已清空",
    ) { copy(history = emptyList(), historyNextCursor = null) }

    fun clearPrivateFeedback() = mutateUnit(
        requiredSection = SavedResourcesSection.PRIVATE_FEEDBACK,
        operation = repository::clearPrivateFeedback,
        successMessage = "私有反馈已清空",
    ) { copy(privateFeedback = emptyList(), feedbackNextCursor = null, submittedFeedback = emptySet()) }

    fun consumeMessage() = mutableState.update { it.copy(message = null) }

    private fun load(
        section: SavedResourcesSection,
        append: Boolean,
        expectedGeneration: Long = resourceGeneration,
    ) {
        if (!resourceAccessIsCurrent(expectedGeneration)) return
        if (mutableState.value.busy || mutableState.value.loginRequired ||
            section !in mutableState.value.enabledSections
        ) return
        val cursor = if (append) when (section) {
            SavedResourcesSection.FAVORITES -> mutableState.value.favoritesNextCursor
            SavedResourcesSection.HISTORY -> mutableState.value.historyNextCursor
            SavedResourcesSection.PRIVATE_FEEDBACK -> mutableState.value.feedbackNextCursor
        } else null
        if (append && cursor == null) return
        val generation = resourceGeneration
        mutableState.update { it.copy(busy = true, message = null) }
        resourceJob = viewModelScope.launch {
            when (section) {
                SavedResourcesSection.FAVORITES -> {
                    val outcome = repository.listFavorites(cursor)
                    if (resourceAccessIsCurrent(generation)) applyPage(outcome) { page ->
                        copy(
                            busy = false,
                            favorites = if (append) {
                                (favorites + page.items).distinctBy { it.favoriteId }
                            } else {
                                page.items
                            },
                            favoritesNextCursor = page.nextCursor,
                            loadedSections = loadedSections + section,
                        )
                    }
                }
                SavedResourcesSection.HISTORY -> {
                    val outcome = repository.listHistory(cursor)
                    if (resourceAccessIsCurrent(generation)) applyPage(outcome) { page ->
                        copy(
                            busy = false,
                            history = if (append) {
                                (history + page.items).distinctBy { it.historyId }
                            } else {
                                page.items
                            },
                            historyNextCursor = page.nextCursor,
                            loadedSections = loadedSections + section,
                        )
                    }
                }
                SavedResourcesSection.PRIVATE_FEEDBACK -> {
                    val outcome = repository.listPrivateFeedback(cursor)
                    if (resourceAccessIsCurrent(generation)) applyPage(outcome) { page ->
                        copy(
                            busy = false,
                            privateFeedback = if (append) {
                                (privateFeedback + page.items).distinctBy { it.feedbackId }
                            } else {
                                page.items
                            },
                            feedbackNextCursor = page.nextCursor,
                            loadedSections = loadedSections + section,
                        )
                    }
                }
            }
        }
    }

    private fun <Value> applyPage(
        outcome: SavedResourcesOutcome<Value>,
        success: SavedResourcesUiState.(Value) -> SavedResourcesUiState,
    ) {
        when (outcome) {
            is SavedResourcesOutcome.Success -> mutableState.update { it.success(outcome.value) }
            is SavedResourcesOutcome.Failure -> mutableState.update {
                it.copy(
                    busy = false,
                    loginRequired = outcome.kind == SavedResourcesFailureKind.LOGIN_REQUIRED,
                    message = outcome.message,
                )
            }
        }
    }

    private fun <Value> applyMutation(
        outcome: SavedResourcesOutcome<Value>,
        successMessage: String,
        success: SavedResourcesUiState.(Value) -> SavedResourcesUiState,
    ) {
        when (outcome) {
            is SavedResourcesOutcome.Success -> mutableState.update {
                it.success(outcome.value).copy(
                    busy = false,
                    loginRequired = false,
                    message = successMessage,
                )
            }
            is SavedResourcesOutcome.Failure -> mutableState.update {
                it.copy(
                    busy = false,
                    loginRequired = outcome.kind == SavedResourcesFailureKind.LOGIN_REQUIRED,
                    message = outcome.message,
                )
            }
        }
    }

    private fun <Value> launchMutation(
        operation: suspend () -> SavedResourcesOutcome<Value>,
        successMessage: String,
        success: SavedResourcesUiState.(Value) -> SavedResourcesUiState,
    ) {
        if (mutableState.value.busy) return
        val generation = resourceGeneration
        mutableState.update { it.copy(busy = true, message = null) }
        resourceJob = viewModelScope.launch {
            val outcome = operation()
            if (resourceAccessIsCurrent(generation)) {
                applyMutation(outcome, successMessage, success)
            }
        }
    }

    private fun mutateUnit(
        requiredSection: SavedResourcesSection,
        operation: suspend () -> SavedResourcesOutcome<Unit>,
        successMessage: String,
        success: SavedResourcesUiState.() -> SavedResourcesUiState,
    ) {
        if (!requireEnabled(requiredSection, "该账号记录能力当前未开放，本次不会修改数据")) return
        if (mutableState.value.busy) return
        val generation = resourceGeneration
        mutableState.update { it.copy(busy = true, message = null) }
        resourceJob = viewModelScope.launch {
            val outcome = operation()
            if (resourceAccessIsCurrent(generation)) {
                applyMutation(outcome, successMessage) { success() }
            }
        }
    }

    private fun mutateUnitLike(
        requiredSection: SavedResourcesSection,
        operation: suspend () -> SavedResourcesOutcome<FavoriteRecord>,
        successMessage: String,
        success: SavedResourcesUiState.(FavoriteRecord) -> SavedResourcesUiState,
    ) {
        if (!requireEnabled(requiredSection, "收藏能力当前未开放，本次不会修改数据")) return
        if (mutableState.value.busy) return
        val generation = resourceGeneration
        mutableState.update { it.copy(busy = true, message = null) }
        resourceJob = viewModelScope.launch {
            val outcome = operation()
            if (resourceAccessIsCurrent(generation)) {
                applyMutation(outcome, successMessage, success)
            }
        }
    }

    private fun requireEnabled(section: SavedResourcesSection, message: String): Boolean {
        if (remoteCapabilitiesCurrent() && section in mutableState.value.enabledSections) return true
        mutableState.update { it.copy(message = message) }
        return false
    }

    private fun invalidateResourceOperations() {
        resourceGeneration += 1
        resourceJob?.cancel()
        resourceJob = null
    }

    private fun remoteCapabilitiesCurrent(): Boolean = capabilityLease?.let(
        runtimeAppVersionGate::isRemoteAccessCurrent,
    ) == true

    private fun resourceAccessIsCurrent(generation: Long): Boolean =
        generation == resourceGeneration && remoteCapabilitiesCurrent()

    private fun revokeForRuntimeGate() {
        invalidateResourceOperations()
        capabilityLease = null
        mutableState.update {
            it.withCapabilities(
                enabled = emptySet(),
                message = "当前版本或远程配置尚未通过校验，账号记录能力保持关闭",
            )
        }
    }

    private fun SavedResourcesUiState.withCapabilities(
        enabled: Set<SavedResourcesSection>,
        message: String?,
    ): SavedResourcesUiState = copy(
        busy = false,
        message = message,
        loginRequired = false,
        enabledSections = enabled,
        favorites = favorites.takeIf { SavedResourcesSection.FAVORITES in enabled }.orEmpty(),
        history = history.takeIf { SavedResourcesSection.HISTORY in enabled }.orEmpty(),
        privateFeedback = privateFeedback.takeIf {
            SavedResourcesSection.PRIVATE_FEEDBACK in enabled
        }.orEmpty(),
        favoritesNextCursor = favoritesNextCursor.takeIf { SavedResourcesSection.FAVORITES in enabled },
        historyNextCursor = historyNextCursor.takeIf { SavedResourcesSection.HISTORY in enabled },
        feedbackNextCursor = feedbackNextCursor.takeIf {
            SavedResourcesSection.PRIVATE_FEEDBACK in enabled
        },
        loadedSections = loadedSections.intersect(enabled),
        favoriteSaved = favoriteSaved && SavedResourcesSection.FAVORITES in enabled,
        submittedFeedback = submittedFeedback.takeIf {
            SavedResourcesSection.PRIVATE_FEEDBACK in enabled
        }.orEmpty(),
    )

    private fun SavedResourcesUiState.clearedAccountData(
        loginRequired: Boolean,
        message: String,
    ): SavedResourcesUiState = copy(
        busy = false,
        loginRequired = loginRequired,
        favorites = emptyList(),
        history = emptyList(),
        privateFeedback = emptyList(),
        favoritesNextCursor = null,
        historyNextCursor = null,
        feedbackNextCursor = null,
        loadedSections = emptySet(),
        favoriteSaved = false,
        submittedFeedback = emptySet(),
        message = message,
    )
}
