package com.chishenme.app.feature.group

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.GroupRecommendationOutcome
import com.chishenme.app.data.GroupRecommendationRepository
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.GroupConstraintAggregation
import com.chishenme.app.data.remote.GroupRecommendationResponse
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.PublicRecommendationDefaults
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.data.remote.effectiveServiceCapabilities
import com.chishenme.app.domain.GroupConstraintAggregator
import com.chishenme.app.domain.GroupDecisionInput
import com.chishenme.app.domain.GroupDecisionInputValidator
import com.chishenme.app.domain.GroupInputValidation
import com.chishenme.app.domain.GroupMemberConstraints
import com.chishenme.app.domain.GroupRecommendationRequestFactory
import com.chishenme.app.domain.RecommendationRadiusPolicy
import com.chishenme.app.feature.config.RuntimeAppVersionGate
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

enum class GroupDecisionPhase {
    CLOSED,
    EDITING,
    REVIEW,
    SUBMITTING,
    RESULT,
    FAILED,
}

data class GroupDecisionUiState(
    val phase: GroupDecisionPhase = GroupDecisionPhase.CLOSED,
    val capabilityAvailable: Boolean = false,
    val dataRightsMode: DataRightsMode? = null,
    val input: GroupDecisionInput = GroupDecisionInput(),
    val activeMemberIndex: Int = 0,
    val confirmedMembers: List<Boolean> = List(2) { false },
    val aggregation: GroupConstraintAggregation? = null,
    val response: GroupRecommendationResponse? = null,
    val formError: String? = null,
    val recommendationDefaults: PublicRecommendationDefaults? = null,
) {
    val busy: Boolean
        get() = phase == GroupDecisionPhase.SUBMITTING

    val softPreferencesAvailable: Boolean
        get() = capabilityAvailable && dataRightsMode == DataRightsMode.LICENSED_ENRICHMENT
}

/**
 * Memory-only authority for the same-device anonymous group flow.
 *
 * The constructor intentionally contains no SavedStateHandle, preferences,
 * history, authentication or saved-resource dependency. A caller should scope
 * this ViewModel to the Activity to survive rotation, then explicitly call one
 * of the clear methods for a real background transition, route exit or privacy
 * withdrawal.
 */
@HiltViewModel
class GroupDecisionViewModel @Inject constructor(
    private val repository: GroupRecommendationRepository,
    private val runtimeAppVersionGate: RuntimeAppVersionGate,
) : ViewModel() {
    private val mutableState = MutableStateFlow(GroupDecisionUiState())
    val state: StateFlow<GroupDecisionUiState> = mutableState.asStateFlow()

    private data class CapabilitySession(
        val lease: RuntimeAppVersionGate.RemoteAccessLease,
        val configurationGeneration: Long,
        val dataRightsMode: DataRightsMode,
        val ruleVersion: String,
        val recommendationDefaults: PublicRecommendationDefaults?,
    )

    private var capabilitySession: CapabilitySession? = null
    private var operationGeneration = 0L
    private var operationJob: Job? = null

    init {
        viewModelScope.launch {
            runtimeAppVersionGate.state.collect {
                val session = capabilitySession
                if (session != null && !runtimeAppVersionGate.isRemoteAccessCurrent(session.lease)) {
                    revokeCapability()
                }
            }
        }
    }

    /** Applies an already fetched configuration; this ViewModel never creates a guest fallback. */
    fun applyFeatureConfig(
        config: FeatureConfig?,
        configurationGeneration: Long?,
    ) {
        val capabilities = config?.effectiveServiceCapabilities()
        val newLease = if (
            config != null &&
            capabilities?.recommendationsEnabled == true &&
            capabilities.groupRecommendationsEnabled &&
            configurationGeneration != null &&
            config.ruleVersion.isNotBlank() &&
            config.ruleVersion.length <= 80 &&
            config.recommendationDefaults?.isValid() != false
        ) {
            runtimeAppVersionGate.acquireRemoteAccessLease(configurationGeneration)
        } else {
            null
        }
        if (
            newLease != null &&
            capabilitySession?.let { existing ->
                existing.configurationGeneration == configurationGeneration &&
                    existing.dataRightsMode == config?.dataRightsMode &&
                    existing.ruleVersion == config.ruleVersion &&
                    existing.recommendationDefaults == config.recommendationDefaults &&
                    runtimeAppVersionGate.isRemoteAccessCurrent(existing.lease)
            } == true
        ) {
            return
        }
        invalidateOperation()
        capabilitySession = if (newLease != null && config != null && configurationGeneration != null) {
            CapabilitySession(
                lease = newLease,
                configurationGeneration = configurationGeneration,
                dataRightsMode = config.dataRightsMode,
                ruleVersion = config.ruleVersion,
                recommendationDefaults = config.recommendationDefaults,
            )
        } else {
            null
        }
        mutableState.value = GroupDecisionUiState(
            capabilityAvailable = newLease != null,
            dataRightsMode = capabilitySession?.dataRightsMode,
            recommendationDefaults = capabilitySession?.recommendationDefaults,
            formError = if (newLease == null) {
                "同设备群组推荐尚未通过当前配置校验"
            } else {
                null
            },
        )
    }

    fun start(): Boolean {
        if (!groupAccessIsCurrent()) {
            mutableState.update {
                GroupDecisionUiState(formError = "同设备群组推荐当前未开放")
            }
            return false
        }
        invalidateOperation()
        mutableState.value = GroupDecisionUiState(
            phase = GroupDecisionPhase.EDITING,
            capabilityAvailable = true,
            dataRightsMode = capabilitySession?.dataRightsMode,
            input = GroupDecisionInput(members = List(2) { defaultMember() }),
            recommendationDefaults = capabilitySession?.recommendationDefaults,
        )
        return true
    }

    fun setLocation(location: Coordinate?) = editInput { copy(location = location) }

    fun setTravelMode(travelMode: TravelMode) = editInput { copy(travelMode = travelMode) }

    fun setMemberCount(count: Int): Boolean {
        if (!canEdit() || count !in GroupDecisionInputValidator.MIN_MEMBERS..GroupDecisionInputValidator.MAX_MEMBERS) {
            return false
        }
        mutableState.update { current ->
            val members = if (count <= current.input.members.size) {
                current.input.members.take(count)
            } else {
                current.input.members + List(count - current.input.members.size) {
                    defaultMember()
                }
            }
            current.copy(
                input = current.input.copy(members = members),
                activeMemberIndex = current.activeMemberIndex.coerceAtMost(count - 1),
                confirmedMembers = current.confirmedMembers.take(count) +
                    List((count - current.confirmedMembers.size).coerceAtLeast(0)) { false },
                aggregation = null,
                response = null,
                formError = null,
            )
        }
        return true
    }

    fun updateMember(index: Int, value: GroupMemberConstraints): Boolean {
        if (!canEdit() || index !in mutableState.value.input.members.indices) return false
        val isolatedValue = normalizeMember(value, capabilitySession?.dataRightsMode)
        mutableState.update { current ->
            current.copy(
                input = current.input.copy(
                    members = current.input.members.mapIndexed { memberIndex, member ->
                        if (memberIndex == index) isolatedValue else member
                    },
                ),
                confirmedMembers = current.confirmedMembers.mapIndexed { memberIndex, confirmed ->
                    if (memberIndex == index) false else confirmed
                },
                aggregation = null,
                response = null,
                formError = null,
            )
        }
        return true
    }

    fun selectMember(index: Int): Boolean {
        if (!canEdit() || index !in mutableState.value.input.members.indices) return false
        mutableState.update { it.copy(activeMemberIndex = index, formError = null) }
        return true
    }

    fun confirmCurrentMember(): Boolean {
        if (!canEdit()) return false
        val current = mutableState.value
        val index = current.activeMemberIndex
        val memberError = validateMember(index, current.input.members[index])
        if (memberError != null) {
            mutableState.update { it.copy(formError = memberError) }
            return false
        }
        mutableState.update { state ->
            state.copy(
                confirmedMembers = state.confirmedMembers.mapIndexed { memberIndex, confirmed ->
                    confirmed || memberIndex == index
                },
                activeMemberIndex = (index + 1).coerceAtMost(state.input.members.lastIndex),
                formError = null,
            )
        }
        return true
    }

    fun review(): Boolean {
        if (!canEdit()) return false
        val snapshot = mutableState.value
        val input = normalizeInput(snapshot.input, capabilitySession?.dataRightsMode)
        if (snapshot.confirmedMembers.size != snapshot.input.members.size ||
            snapshot.confirmedMembers.any { !it }
        ) {
            mutableState.update { it.copy(formError = "请依次确认每位成员的条件") }
            return false
        }
        return when (val validation = GroupDecisionInputValidator.validate(input)) {
            is GroupInputValidation.Invalid -> {
                mutableState.update { it.copy(formError = validation.message) }
                false
            }
            GroupInputValidation.Valid -> {
                val aggregation = GroupConstraintAggregator.aggregate(input.members)
                val radiusError = groupRadiusError(aggregation)
                if (radiusError != null) {
                    mutableState.update { it.copy(formError = radiusError) }
                    return false
                }
                mutableState.update {
                    it.copy(
                        phase = GroupDecisionPhase.REVIEW,
                        input = input,
                        aggregation = aggregation,
                        response = null,
                        formError = null,
                    )
                }
                true
            }
        }
    }

    fun edit(): Boolean {
        if (mutableState.value.phase !in setOf(
                GroupDecisionPhase.REVIEW,
                GroupDecisionPhase.RESULT,
                GroupDecisionPhase.FAILED,
            ) || !groupAccessIsCurrent()
        ) return false
        invalidateOperation()
        mutableState.update {
            it.copy(
                phase = GroupDecisionPhase.EDITING,
                aggregation = null,
                response = null,
                formError = null,
            )
        }
        return true
    }

    fun submit(): Boolean {
        val snapshot = mutableState.value
        if (snapshot.phase != GroupDecisionPhase.REVIEW) return false
        return launchRequest(snapshot.input, snapshot.aggregation ?: return false)
    }

    /** Reuses the exact in-memory input; no cross-request result identity is retained. */
    fun retry(): Boolean {
        val snapshot = mutableState.value
        if (snapshot.phase !in setOf(GroupDecisionPhase.RESULT, GroupDecisionPhase.FAILED)) {
            return false
        }
        val aggregation = GroupConstraintAggregator.aggregate(snapshot.input.members)
        return launchRequest(snapshot.input, aggregation)
    }

    fun clearForExit() = clearSession()

    fun clearForPrivacyWithdrawal() = clearSession()

    /** Call only for a process/activity transition confirmed to be a real background event. */
    fun clearForBackground() = clearSession()

    fun clear() = clearSession()

    private fun launchRequest(
        input: GroupDecisionInput,
        aggregation: GroupConstraintAggregation,
    ): Boolean {
        val session = currentSession()
        if (session == null) {
            revokeCapability("群组推荐权限已失效，请重新进入")
            return false
        }
        val normalizedInput = normalizeInput(input, session.dataRightsMode)
        if (normalizedInput != input ||
            GroupDecisionInputValidator.validate(normalizedInput) != GroupInputValidation.Valid ||
            GroupConstraintAggregator.aggregate(normalizedInput.members) != aggregation
        ) {
            mutableState.update {
                it.copy(
                    phase = GroupDecisionPhase.EDITING,
                    input = normalizedInput,
                    confirmedMembers = List(normalizedInput.members.size) { false },
                    aggregation = null,
                    response = null,
                    formError = "共同条件已变化，请重新确认成员条件并复核",
                )
            }
            return false
        }
        val radiusError = groupRadiusError(aggregation)
        if (radiusError != null) {
            mutableState.update {
                it.copy(
                    phase = GroupDecisionPhase.EDITING,
                    aggregation = null,
                    response = null,
                    formError = radiusError,
                )
            }
            return false
        }
        val request = GroupRecommendationRequestFactory.create(normalizedInput)
        val generation = invalidateOperation()
        mutableState.update {
            it.copy(
                phase = GroupDecisionPhase.SUBMITTING,
                aggregation = aggregation,
                response = null,
                formError = null,
            )
        }
        operationJob = viewModelScope.launch {
            when (
                val outcome = repository.recommend(
                    request = request,
                    expectedAggregation = aggregation,
                    expectedDataRightsMode = session.dataRightsMode,
                    expectedRuleVersion = session.ruleVersion,
                )
            ) {
                is GroupRecommendationOutcome.Success -> {
                    currentCoroutineContext().ensureActive()
                    if (!operationIsCurrent(generation, session)) return@launch
                    mutableState.update { current ->
                        if (!operationIsCurrent(generation, session)) current else current.copy(
                            phase = GroupDecisionPhase.RESULT,
                            response = outcome.response,
                            formError = null,
                        )
                    }
                }
                is GroupRecommendationOutcome.Failure -> {
                    currentCoroutineContext().ensureActive()
                    if (!operationIsCurrent(generation, session)) return@launch
                    mutableState.update { current ->
                        if (!operationIsCurrent(generation, session)) current else current.copy(
                            phase = GroupDecisionPhase.FAILED,
                            response = null,
                            formError = outcome.message,
                        )
                    }
                }
            }
        }
        return true
    }

    private fun editInput(transform: GroupDecisionInput.() -> GroupDecisionInput): Boolean {
        if (!canEdit()) return false
        mutableState.update {
            it.copy(
                input = it.input.transform(),
                aggregation = null,
                response = null,
                formError = null,
            )
        }
        return true
    }

    private fun canEdit(): Boolean =
        mutableState.value.phase == GroupDecisionPhase.EDITING && groupAccessIsCurrent()

    /** Normalize every entry point so an old UI draft cannot restore unsupported preferences. */
    private fun normalizeMember(
        member: GroupMemberConstraints,
        dataRightsMode: DataRightsMode?,
    ) = member.copy(
        preferredCuisines = if (dataRightsMode == DataRightsMode.LICENSED_ENRICHMENT) {
            member.preferredCuisines.toSet()
        } else {
            emptySet()
        },
        excludedCuisines = member.excludedCuisines.toSet(),
    )

    private fun normalizeInput(
        input: GroupDecisionInput,
        dataRightsMode: DataRightsMode?,
    ) = input.copy(members = input.members.map { normalizeMember(it, dataRightsMode) })

    private fun defaultMember() = GroupMemberConstraints(
        radiusMeters = RecommendationRadiusPolicy.automaticRadius(
            MealPeriod.LUNCH,
            capabilitySession?.recommendationDefaults,
        ),
    )

    /** A member may accept a wider radius when the shared intersection stays in range. */
    private fun groupRadiusError(aggregation: GroupConstraintAggregation): String? {
        val maximum = RecommendationRadiusPolicy.maximumRadius(capabilitySession?.recommendationDefaults)
        return if (aggregation.effectiveRadiusMeters > maximum) {
            "共同最远距离为 ${aggregation.effectiveRadiusMeters} 米，当前服务最远支持 $maximum 米。请由成员主动调整距离，再复核共同条件。"
        } else null
    }

    private fun validateMember(index: Int, member: GroupMemberConstraints): String? {
        val ordinal = index + 1
        return when {
            member.budgetMaxYuan != null && member.budgetMaxYuan !in 1..2_000 ->
                "第 $ordinal 位成员的人均预算需在 1–2000 元之间"
            member.availableMinutes !in 15..240 ->
                "第 $ordinal 位成员的可用时间需在 15–240 分钟之间"
            member.radiusMeters !in 200..10_000 ->
                "第 $ordinal 位成员的最远距离需在 200 米–10 公里之间"
            member.preferredCuisines.size > GroupDecisionInputValidator.MAX_CUISINES_PER_KIND ||
                member.excludedCuisines.size > GroupDecisionInputValidator.MAX_CUISINES_PER_KIND ->
                "第 $ordinal 位成员的偏好和排除菜系最多各 8 项"
            member.preferredCuisines.any(member.excludedCuisines::contains) ->
                "第 $ordinal 位成员不能同时偏好并排除同一菜系"
            else -> null
        }
    }

    private fun currentSession(): CapabilitySession? {
        val session = capabilitySession ?: return null
        val freshLease = runtimeAppVersionGate.acquireRemoteAccessLease(
            session.configurationGeneration,
        ) ?: return null
        return session.takeIf {
            freshLease.configurationGeneration == session.configurationGeneration &&
                runtimeAppVersionGate.isRemoteAccessCurrent(session.lease)
        }
    }

    private fun groupAccessIsCurrent(): Boolean = currentSession() != null &&
        mutableState.value.capabilityAvailable

    private fun operationIsCurrent(
        generation: Long,
        session: CapabilitySession,
    ): Boolean =
        generation == operationGeneration &&
            capabilitySession == session &&
            runtimeAppVersionGate.isRemoteAccessCurrent(session.lease) &&
            mutableState.value.capabilityAvailable

    private fun invalidateOperation(): Long {
        check(operationGeneration < Long.MAX_VALUE) { "Group operation generation exhausted" }
        operationGeneration += 1
        operationJob?.cancel()
        operationJob = null
        return operationGeneration
    }

    private fun revokeCapability(message: String? = null) {
        invalidateOperation()
        capabilitySession = null
        mutableState.value = GroupDecisionUiState(
            formError = message ?: "同设备群组推荐的配置权限已撤销",
        )
    }

    private fun clearSession() {
        invalidateOperation()
        capabilitySession = null
        mutableState.value = GroupDecisionUiState()
    }

    override fun onCleared() {
        clearSession()
        super.onCleared()
    }
}
