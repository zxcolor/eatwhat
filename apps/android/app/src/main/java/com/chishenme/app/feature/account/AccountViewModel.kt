package com.chishenme.app.feature.account

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.auth.qq.QqOAuthEvent
import com.chishenme.app.auth.qq.QqOAuthFailure
import com.chishenme.app.auth.qq.QqLoginHost
import com.chishenme.app.auth.qq.QqOAuthManager
import com.chishenme.app.auth.qq.QqOAuthStartResult
import com.chishenme.app.auth.qq.toQqLoginHost
import com.chishenme.app.auth.wechat.WechatOAuthEvent
import com.chishenme.app.auth.wechat.WechatOAuthFailure
import com.chishenme.app.auth.wechat.WechatOAuthManager
import com.chishenme.app.auth.wechat.WechatOAuthStartResult
import com.chishenme.app.data.AccountAuthActions
import com.chishenme.app.data.AccountExportActions
import com.chishenme.app.data.AccountExportFailureKind
import com.chishenme.app.data.AccountExportOutcome
import com.chishenme.app.data.AuthOutcome
import com.chishenme.app.data.LocalAuthSession
import com.chishenme.app.data.remote.AccountExportStatus
import com.chishenme.app.data.remote.AccountExportStatusResponse
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.AuthCodeChallenge
import com.chishenme.app.data.remote.AuthIdentityBinding
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthSessionSummary
import com.chishenme.app.data.remote.OAuthPurpose
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import dagger.hilt.android.lifecycle.HiltViewModel
import java.time.Instant
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AccountStatus { CHECKING, GUEST, SIGNED_IN }

data class PendingOtpChallenge(
    val type: AuthIdentityType,
    val purpose: OtpPurpose,
    val challengeId: String,
    val maskedTarget: String,
    val expiresAt: Instant,
)

data class AccountUiState(
    val status: AccountStatus = AccountStatus.CHECKING,
    val busy: Boolean = false,
    val challenge: PendingOtpChallenge? = null,
    val identities: List<AuthIdentityBinding> = emptyList(),
    val sessions: List<AuthSessionSummary> = emptyList(),
    val message: String? = null,
    val export: AccountExportStatusResponse? = null,
    val exportBusy: Boolean = false,
    val dataExportEnabled: Boolean = false,
    val includeBehaviorHistory: Boolean = true,
    val wechatClientConfigured: Boolean = false,
    val qqClientConfigured: Boolean = false,
    val localSessionMaterialPresent: Boolean = false,
)

@HiltViewModel
class AccountViewModel @Inject constructor(
    private val repository: AccountAuthActions,
    private val exportRepository: AccountExportActions,
    private val wechatOAuth: WechatOAuthManager,
    private val qqOAuth: QqOAuthManager,
    private val runtimeAppVersionGate: RuntimeAppVersionGate,
) : ViewModel() {
    private val mutableState = MutableStateFlow(
        AccountUiState(
            wechatClientConfigured = wechatOAuth.clientConfigured,
            qqClientConfigured = qqOAuth.clientConfigured,
        ),
    )
    val state: StateFlow<AccountUiState> = mutableState.asStateFlow()
    private var pendingWechatAction: PendingWechatAction? = null
    private var pendingQqAction: PendingQqAction? = null
    private var stagedWechatEvent: WechatOAuthEvent? = null
    private var stagedQqEvent: QqOAuthEvent? = null
    private var remoteActionJob: Job? = null
    private var logoutJob: Job? = null
    private var dataRightsJob: Job? = null
    private var logoutInProgress = false
    private var dataRightsInProgress = false
    private var localAccountEpoch = 0L
    private var deletionExplicitlyDisabled = false
    private var remoteAccessGeneration = 0L
    private var latestConfigGeneration = -1L
    private var syntheticConfigGeneration = 0L
    private var configPhase = AccountConfigPhase.LOADING
    private var activeCapabilities: AuthCapabilities? = null
    private var activeRuntimeLease: RuntimeAppVersionGate.RemoteAccessLease? = null
    private var exportJob: Job? = null
    private var exportAccessGeneration = 0L

    init {
        viewModelScope.launch {
            wechatOAuth.events.collect(::handleWechatEvent)
        }
        viewModelScope.launch {
            qqOAuth.events.collect(::handleQqEvent)
        }
        viewModelScope.launch {
            runtimeAppVersionGate.state.collect { gate ->
                if (!gate.remoteFeaturesAllowed) {
                    enterConfigLoading(
                        gate.observedConfigurationGeneration ?: (latestConfigGeneration + 1),
                    )
                }
            }
        }
    }

    /**
     * The destination may be composed before remote config arrives. Do not
     * touch the auth network/storage graph until the server capability is
     * explicitly enabled for this consented session.
     */
    fun start(remoteFeatureConfig: RemoteFeatureConfigState) {
        if (remoteFeatureConfig.generation < latestConfigGeneration) return
        if (runtimeAppVersionGate.currentState.status ==
            RuntimeAppVersionGate.Status.UPDATE_REQUIRED
        ) {
            enterConfigLoading(remoteFeatureConfig.generation)
            return
        }
        when (remoteFeatureConfig) {
            is RemoteFeatureConfigState.Loading -> enterConfigLoading(remoteFeatureConfig.generation)
            is RemoteFeatureConfigState.Ready -> enterConfigReady(
                generation = remoteFeatureConfig.generation,
                capabilities = remoteFeatureConfig.config.authCapabilities,
            )
            is RemoteFeatureConfigState.Unavailable -> enterConfigTerminal(
                generation = remoteFeatureConfig.generation,
                phase = AccountConfigPhase.UNAVAILABLE,
            )
            is RemoteFeatureConfigState.Incompatible -> enterConfigTerminal(
                generation = remoteFeatureConfig.generation,
                phase = AccountConfigPhase.INCOMPATIBLE,
            )
        }
    }

    /** Test-only convenience for capability-focused tests that do not build a full config DTO. */
    internal fun start(capabilities: AuthCapabilities?) {
        val generation = maxOf(++syntheticConfigGeneration, latestConfigGeneration + 1)
        syntheticConfigGeneration = generation
        runtimeAppVersionGate.markConfigurationUntrusted(generation)
        enterConfigLoading(generation)
        if (capabilities == null) {
            runtimeAppVersionGate.markConfigurationUnavailable(generation)
            enterConfigTerminal(generation, AccountConfigPhase.UNAVAILABLE)
        } else {
            runtimeAppVersionGate.acceptTrustedConfiguration(generation, "0.1.0")
            enterConfigReady(generation, capabilities)
        }
    }

    /**
     * Called synchronously from the account destination's ON_STOP observer.
     * OAuth provider callbacks may arrive before Compose resumes collecting the
     * refreshed DecisionUiState, so waiting for a later LaunchedEffect would
     * leave a stale READY window. This only revokes the account's local action
     * lease; the process-wide gate owns configuration generation allocation.
     */
    fun suspendRemoteAccessForForegroundRefresh() {
        val observedGeneration = runtimeAppVersionGate.currentState.observedConfigurationGeneration ?: 0L
        val generation = maxOf(latestConfigGeneration, observedGeneration)
        enterConfigLoading(generation)
    }

    private fun enterConfigLoading(generation: Long) {
        if (
            generation < latestConfigGeneration ||
            generation == latestConfigGeneration && configPhase == AccountConfigPhase.LOADING
        ) {
            return
        }
        latestConfigGeneration = generation
        configPhase = AccountConfigPhase.LOADING
        activeCapabilities = null
        activeRuntimeLease = null
        deletionExplicitlyDisabled = false
        revokeRemoteActions(preserveExternalAuthorization = true)
    }

    private fun enterConfigReady(generation: Long, capabilities: AuthCapabilities?) {
        if (generation < latestConfigGeneration) return
        val runtimeLease = runtimeAppVersionGate.acquireRemoteAccessLease(generation)
        if (runtimeLease == null) {
            enterConfigLoading(generation)
            return
        }
        if (
            generation == latestConfigGeneration &&
            configPhase == AccountConfigPhase.READY &&
            activeCapabilities == capabilities
        ) {
            return
        }
        if (generation > latestConfigGeneration || configPhase != AccountConfigPhase.LOADING) {
            latestConfigGeneration = generation
            revokeRemoteActions(preserveExternalAuthorization = true)
        }
        if (generation != latestConfigGeneration) return
        configPhase = AccountConfigPhase.READY
        activeCapabilities = capabilities
        activeRuntimeLease = runtimeLease
        remoteAccessGeneration += 1

        val accountsEnabled = capabilities?.accountsEnabled == true
        deletionExplicitlyDisabled = capabilities?.accountsEnabled != true
        updateExportCapability(accountsEnabled && capabilities?.dataExportEnabled == true)
        if (!accountsEnabled) {
            clearExternalAuthorization()
            mutableState.update {
                it.copy(
                    status = if (it.status == AccountStatus.CHECKING) AccountStatus.GUEST else it.status,
                    busy = false,
                    challenge = null,
                    identities = emptyList(),
                    sessions = emptyList(),
                )
            }
            return
        }

        discardAuthorizationsDisabledByLatestConfig()
        val resumedAuthorization = resumeStagedAuthorization()
        if (resumedAuthorization) return
        if (pendingWechatAction != null || pendingQqAction != null) {
            mutableState.update { it.copy(busy = true) }
            return
        }
        if (
            mutableState.value.status != AccountStatus.SIGNED_IN &&
            logoutJob?.isCompleted != false
        ) {
            restore()
        } else if (
            mutableState.value.status == AccountStatus.SIGNED_IN &&
            mutableState.value.dataExportEnabled &&
            !mutableState.value.busy
        ) {
            refreshExport(showMessage = false)
        }
    }

    private fun enterConfigTerminal(generation: Long, phase: AccountConfigPhase) {
        if (generation < latestConfigGeneration) return
        if (generation == latestConfigGeneration && configPhase == phase) return
        if (generation > latestConfigGeneration || configPhase != AccountConfigPhase.LOADING) {
            latestConfigGeneration = generation
            revokeRemoteActions(preserveExternalAuthorization = false)
        }
        if (generation != latestConfigGeneration) return
        configPhase = phase
        activeCapabilities = null
        activeRuntimeLease = null
        deletionExplicitlyDisabled = true
        updateExportCapability(false)
        clearExternalAuthorization()
        mutableState.update {
            it.copy(
                status = if (it.status == AccountStatus.CHECKING) AccountStatus.GUEST else it.status,
                busy = false,
                challenge = null,
                identities = emptyList(),
                sessions = emptyList(),
            )
        }
    }

    private fun updateExportCapability(dataExportEnabled: Boolean) {
        val previousExportEnabled = mutableState.value.dataExportEnabled
        if (previousExportEnabled != dataExportEnabled) {
            exportAccessGeneration += 1
            val revokedJob = if (!dataExportEnabled) exportJob?.also { it.cancel() } else null
            mutableState.update {
                it.copy(
                    dataExportEnabled = dataExportEnabled,
                    export = if (dataExportEnabled) it.export else null,
                    exportBusy = dataExportEnabled && exportJob?.isCompleted == false,
                    includeBehaviorHistory = if (dataExportEnabled) {
                        it.includeBehaviorHistory
                    } else {
                        true
                    },
                )
            }
            if (revokedJob != null) finishCapabilityRevocation(revokedJob)
            if (
                dataExportEnabled &&
                mutableState.value.status == AccountStatus.SIGNED_IN &&
                !mutableState.value.busy
            ) {
                refreshExport(showMessage = false)
            }
        }
    }

    private fun revokeRemoteActions(preserveExternalAuthorization: Boolean) {
        remoteAccessGeneration += 1
        remoteActionJob?.cancel()
        remoteActionJob = null
        updateExportCapability(false)
        mutableState.update {
            it.copy(
                busy = logoutInProgress || dataRightsInProgress,
                challenge = null,
                identities = emptyList(),
                sessions = emptyList(),
            )
        }
        if (!preserveExternalAuthorization) clearExternalAuthorization()
    }

    private fun launchRemoteAction(
        allowBusy: Boolean = false,
        operation: suspend (generation: Long) -> Unit,
    ): Boolean {
        if (!accountsAccessIsReady()) return false
        if (!allowBusy && (mutableState.value.busy || remoteActionJob?.isCompleted == false)) {
            return false
        }
        val generation = remoteAccessGeneration
        val launched = viewModelScope.launch {
            if (!remoteAccessIsCurrent(generation)) return@launch
            operation(generation)
        }
        remoteActionJob = launched
        launched.invokeOnCompletion {
            if (remoteActionJob === launched) remoteActionJob = null
        }
        return true
    }

    private fun accountsAccessIsReady(): Boolean =
        !logoutInProgress &&
            !dataRightsInProgress &&
            activeRuntimeLease?.let(runtimeAppVersionGate::isRemoteAccessCurrent) == true &&
            configPhase == AccountConfigPhase.READY &&
            activeCapabilities?.accountsEnabled == true

    private fun remoteAccessIsCurrent(generation: Long): Boolean =
        generation == remoteAccessGeneration && accountsAccessIsReady()

    private inline fun updateRemoteState(
        generation: Long,
        transform: (AccountUiState) -> AccountUiState,
    ) {
        if (!remoteAccessIsCurrent(generation)) return
        mutableState.update { current ->
            if (remoteAccessIsCurrent(generation)) transform(current) else current
        }
    }

    fun restore() {
        launchRemoteAction { generation ->
            updateRemoteState(generation) {
                it.copy(status = AccountStatus.CHECKING, busy = true, message = null)
            }
            cancelExportJob()
            updateRemoteState(generation) { it.copy(identities = emptyList(), sessions = emptyList()) }
            when (val outcome = repository.restoreSession()) {
                is AuthOutcome.Success -> {
                    updateRemoteState(generation) {
                        it.copy(
                            status = if (outcome.value == null) AccountStatus.GUEST else AccountStatus.SIGNED_IN,
                            busy = false,
                        )
                    }
                    if (remoteAccessIsCurrent(generation) && outcome.value != null) {
                        refreshSecurityData(allowCurrentAction = true)
                    }
                }
                is AuthOutcome.Failure -> updateRemoteState(generation) {
                    it.copy(status = AccountStatus.GUEST, busy = false, message = outcome.message)
                }
            }
        }
    }

    /**
     * Minimum-version enforcement must not erase statutory account controls.
     * This path restores only the local session (and a refresh when the stored
     * token requires it); it never loads providers, bindings, sessions or export.
     */
    fun startDataRightsOnly() {
        if (logoutInProgress || dataRightsJob?.isCompleted == false) return
        deletionExplicitlyDisabled = false
        dataRightsInProgress = true
        val accountEpoch = localAccountEpoch
        mutableState.update {
            it.copy(
                status = AccountStatus.CHECKING,
                busy = true,
                challenge = null,
                identities = emptyList(),
                sessions = emptyList(),
                dataExportEnabled = false,
                export = null,
                exportBusy = false,
                message = null,
            )
        }
        val launched = viewModelScope.launch {
            val hasLocalMaterial = try {
                repository.hasLocalSessionMaterial()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // An unreadable local store must not hide the user's local-exit control.
                true
            }
            if (accountEpoch != localAccountEpoch) return@launch
            mutableState.update { it.copy(localSessionMaterialPresent = hasLocalMaterial) }
            if (!hasLocalMaterial) {
                mutableState.update {
                    it.copy(status = AccountStatus.GUEST, busy = false, message = null)
                }
                return@launch
            }
            when (val restored = repository.restoreSession()) {
                is AuthOutcome.Success -> if (accountEpoch == localAccountEpoch) {
                    mutableState.update {
                        it.copy(
                            status = if (restored.value == null) {
                                AccountStatus.GUEST
                            } else {
                                AccountStatus.SIGNED_IN
                            },
                            busy = false,
                            message = null,
                            localSessionMaterialPresent = true,
                        )
                    }
                }
                is AuthOutcome.Failure -> if (accountEpoch == localAccountEpoch) {
                    mutableState.update {
                        it.copy(
                            status = AccountStatus.GUEST,
                            busy = false,
                            message = restored.message,
                            localSessionMaterialPresent = true,
                        )
                    }
                }
            }
        }
        dataRightsJob = launched
        launched.invokeOnCompletion {
            if (dataRightsJob === launched) {
                dataRightsJob = null
                dataRightsInProgress = false
                if (!logoutInProgress && accountEpoch == localAccountEpoch) {
                    mutableState.update { it.copy(busy = false) }
                }
            }
        }
    }

    fun requestCode(type: AuthIdentityType, purpose: OtpPurpose, target: String) {
        if (!otpCapabilityIsReady(type, purpose)) return
        launchRemoteAction { generation ->
            updateRemoteState(generation) {
                it.copy(busy = true, challenge = null, message = null)
            }
            val outcome = when (type) {
                AuthIdentityType.PHONE -> repository.requestPhoneCode(target, purpose)
                AuthIdentityType.EMAIL -> repository.requestEmailCode(target, purpose)
                else -> AuthOutcome.Failure(
                    com.chishenme.app.data.AuthFailureKind.INPUT,
                    "该方式不使用验证码",
                )
            }
            when (outcome) {
                is AuthOutcome.Success -> updateRemoteState(generation) {
                    it.copy(
                        busy = false,
                        challenge = outcome.value.toPending(purpose),
                        message = "验证码已发送至 ${outcome.value.maskedTarget}",
                    )
                }
                is AuthOutcome.Failure -> updateRemoteState(generation) {
                    it.copy(busy = false, message = outcome.message)
                }
            }
        }
    }

    fun submitLoginCode(otpCode: String) {
        val challenge = mutableState.value.challenge
        if (challenge?.purpose != OtpPurpose.LOGIN || !otpCapabilityIsReady(challenge.type, challenge.purpose)) return
        launchRemoteAction { generation ->
            updateRemoteState(generation) { it.copy(busy = true, message = null) }
            cancelExportJob()
            when (
                val outcome = repository.loginWithOtp(
                    challenge.type,
                    challenge.challengeId,
                    otpCode.trim(),
                )
            ) {
                is AuthOutcome.Success -> signedIn(outcome.value, generation)
                is AuthOutcome.Failure -> updateRemoteState(generation) {
                    it.copy(busy = false, message = outcome.message)
                }
            }
        }
    }

    fun submitBindCode(otpCode: String) {
        val challenge = mutableState.value.challenge
        if (challenge?.purpose != OtpPurpose.BIND || !otpCapabilityIsReady(challenge.type, challenge.purpose)) return
        launchRemoteAction { generation ->
            updateRemoteState(generation) { it.copy(busy = true, message = null) }
            when (
                val outcome = repository.bindWithOtp(
                    challenge.type,
                    challenge.challengeId,
                    otpCode.trim(),
                )
            ) {
                is AuthOutcome.Success -> {
                    updateRemoteState(generation) {
                        it.copy(busy = false, challenge = null, message = "身份已安全绑定")
                    }
                    if (remoteAccessIsCurrent(generation)) {
                        refreshSecurityData(allowCurrentAction = true)
                    }
                }
                is AuthOutcome.Failure -> updateRemoteState(generation) {
                    it.copy(busy = false, message = outcome.message)
                }
            }
        }
    }

    fun startWechatLogin() = beginWechatAuthorization(OAuthPurpose.LOGIN)

    fun startQqLogin(activity: Activity) = beginQqAuthorization(activity, OAuthPurpose.LOGIN)

    internal fun startQqLogin(host: QqLoginHost) = beginQqAuthorization(host, OAuthPurpose.LOGIN)

    fun submitPhoneWechatRegistration(otpCode: String) {
        val challenge = mutableState.value.challenge
        if (
            challenge?.purpose != OtpPurpose.REGISTER ||
            challenge.type != AuthIdentityType.PHONE ||
            !otpCode.trim().matches(OTP_CODE_PATTERN)
        ) {
            mutableState.update { it.copy(message = "请先完成手机号验证码申请并输入 6 位验证码") }
            return
        }
        beginWechatAuthorization(
            purpose = OAuthPurpose.REGISTER,
            phoneChallengeId = challenge.challengeId,
            phoneOtpCode = otpCode.trim(),
        )
    }

    fun startQqBind(activity: Activity) {
        if (mutableState.value.status != AccountStatus.SIGNED_IN || !qqCapabilityIsReady()) return
        beginQqAuthorization(activity, OAuthPurpose.BIND)
    }

    internal fun startQqBind(host: QqLoginHost) {
        if (mutableState.value.status != AccountStatus.SIGNED_IN || !qqCapabilityIsReady()) return
        beginQqAuthorization(host, OAuthPurpose.BIND)
    }

    fun refreshSecurityData() = refreshSecurityData(allowCurrentAction = false)

    private fun refreshSecurityData(allowCurrentAction: Boolean) {
        if (mutableState.value.status != AccountStatus.SIGNED_IN) return
        launchRemoteAction(allowBusy = allowCurrentAction) { generation ->
            updateRemoteState(generation) { it.copy(busy = true, message = null) }
            val identities = repository.identities()
            if (!remoteAccessIsCurrent(generation)) return@launchRemoteAction
            val sessions = repository.sessions()
            if (!remoteAccessIsCurrent(generation)) return@launchRemoteAction
            val firstFailure = when {
                identities is AuthOutcome.Failure -> identities
                sessions is AuthOutcome.Failure -> sessions
                else -> null
            }
            updateRemoteState(generation) { current ->
                current.copy(
                    busy = false,
                    identities = if (identities is AuthOutcome.Success) {
                        identities.value
                    } else {
                        current.identities
                    },
                    sessions = if (sessions is AuthOutcome.Success) {
                        sessions.value
                    } else {
                        current.sessions
                    },
                    message = firstFailure?.message,
                )
            }
            if (
                remoteAccessIsCurrent(generation) &&
                mutableState.value.dataExportEnabled &&
                mutableState.value.status == AccountStatus.SIGNED_IN
            ) {
                refreshExport(showMessage = false)
            }
        }
    }

    fun unbind(bindingId: String) = authenticatedMutation(
        successMessage = "身份已解绑",
        operation = { repository.unbindIdentity(bindingId) },
    )

    fun revokeSession(sessionId: String) = authenticatedMutation(
        successMessage = "设备会话已退出",
        operation = { repository.revokeSession(sessionId) },
    )

    fun setIncludeBehaviorHistory(include: Boolean) {
        if (!mutableState.value.dataExportEnabled || mutableState.value.exportBusy) return
        mutableState.update { it.copy(includeBehaviorHistory = include) }
    }

    fun requestExport() {
        val snapshot = mutableState.value
        if (
            !accountsAccessIsReady() ||
            !snapshot.dataExportEnabled ||
            snapshot.busy ||
            snapshot.exportBusy ||
            snapshot.status != AccountStatus.SIGNED_IN
        ) {
            return
        }
        launchExportJob { generation ->
            when (val outcome = exportRepository.request(snapshot.includeBehaviorHistory)) {
                is AccountExportOutcome.Success -> updateExportState(generation) {
                    val receipt = outcome.value
                    it.copy(
                        exportBusy = false,
                        export = AccountExportStatusResponse(
                            exportId = receipt.exportId,
                            status = receipt.status,
                            requestedAt = receipt.requestedAt,
                            expiresAt = receipt.expiresAt,
                            includeBehaviorHistory = receipt.includeBehaviorHistory,
                            downloadAvailable = false,
                        ),
                        message = "数据导出任务已创建，可稍后刷新状态",
                    )
                }
                is AccountExportOutcome.Failure -> applyExportFailure(outcome, generation)
            }
        }
    }

    fun refreshExport() = refreshExport(showMessage = true)

    private fun refreshExport(showMessage: Boolean) {
        val snapshot = mutableState.value
        if (
            !accountsAccessIsReady() ||
            !snapshot.dataExportEnabled ||
            snapshot.busy ||
            snapshot.exportBusy ||
            snapshot.status != AccountStatus.SIGNED_IN
        ) {
            return
        }
        launchExportJob { generation ->
            when (val outcome = exportRepository.latest()) {
                is AccountExportOutcome.Success -> updateExportState(generation) {
                    it.copy(
                        exportBusy = false,
                        export = outcome.value,
                        includeBehaviorHistory = outcome.value?.includeBehaviorHistory
                            ?: it.includeBehaviorHistory,
                        message = if (!showMessage) {
                            it.message
                        } else if (outcome.value == null) {
                            "当前没有数据导出任务"
                        } else {
                            "导出状态已刷新"
                        },
                    )
                }
                is AccountExportOutcome.Failure -> applyExportFailure(outcome, generation)
            }
        }
    }

    fun downloadExport(destinationUri: String) {
        val snapshot = mutableState.value
        val export = snapshot.export
        if (
            !accountsAccessIsReady() ||
            !snapshot.dataExportEnabled ||
            snapshot.busy ||
            snapshot.exportBusy ||
            snapshot.status != AccountStatus.SIGNED_IN ||
            export?.status != AccountExportStatus.READY
        ) {
            return
        }
        launchExportJob { generation ->
            when (val outcome = exportRepository.download(export, destinationUri)) {
                is AccountExportOutcome.Success -> updateExportState(generation) {
                    it.copy(exportBusy = false, message = "数据导出文件已保存并通过完整性校验")
                }
                is AccountExportOutcome.Failure -> applyExportFailure(outcome, generation)
            }
        }
    }

    fun logout() {
        if (logoutInProgress) return
        logoutInProgress = true
        localAccountEpoch += 1
        remoteAccessGeneration += 1
        remoteActionJob?.cancel()
        remoteActionJob = null
        dataRightsJob?.cancel()
        dataRightsJob = null
        dataRightsInProgress = false
        clearExternalAuthorization()
        val exportCapability = mutableState.value.dataExportEnabled
        mutableState.value = AccountUiState(
            status = AccountStatus.GUEST,
            busy = true,
            dataExportEnabled = exportCapability,
            wechatClientConfigured = wechatOAuth.clientConfigured,
            qqClientConfigured = qqOAuth.clientConfigured,
        )
        logoutJob?.cancel()
        val launched = viewModelScope.launch {
            cancelExportJob()
            val message = try {
                val outcome = repository.logout()
                (outcome as? AuthOutcome.Failure)?.message ?: "已退出登录"
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                "本机登录信息已清除"
            } finally {
                logoutInProgress = false
            }
            mutableState.value = AccountUiState(
                status = AccountStatus.GUEST,
                message = message,
                dataExportEnabled = exportCapability && accountsAccessIsReady(),
                wechatClientConfigured = wechatOAuth.clientConfigured,
                qqClientConfigured = qqOAuth.clientConfigured,
            )
        }
        logoutJob = launched
        launched.invokeOnCompletion {
            if (logoutJob === launched) logoutJob = null
        }
    }

    fun deleteAccount() {
        if (
            mutableState.value.status != AccountStatus.SIGNED_IN ||
            mutableState.value.busy ||
            logoutInProgress ||
            deletionExplicitlyDisabled ||
            dataRightsJob?.isCompleted == false
        ) return
        dataRightsInProgress = true
        val accountEpoch = localAccountEpoch
        mutableState.update { it.copy(busy = true, message = null) }
        val launched = viewModelScope.launch {
            cancelExportJob()
            when (val outcome = repository.deleteAccount()) {
                is AuthOutcome.Success -> if (accountEpoch == localAccountEpoch) {
                    mutableState.value = AccountUiState(
                        status = AccountStatus.GUEST,
                        message = "账号已停用，个人信息将按公示期限清理",
                        dataExportEnabled = mutableState.value.dataExportEnabled,
                        wechatClientConfigured = wechatOAuth.clientConfigured,
                        qqClientConfigured = qqOAuth.clientConfigured,
                    )
                }
                is AuthOutcome.Failure -> if (accountEpoch == localAccountEpoch) {
                    mutableState.update { it.copy(busy = false, message = outcome.message) }
                }
            }
        }
        dataRightsJob = launched
        launched.invokeOnCompletion {
            if (dataRightsJob === launched) {
                dataRightsJob = null
                dataRightsInProgress = false
                if (!logoutInProgress && accountEpoch == localAccountEpoch) {
                    mutableState.update { it.copy(busy = false) }
                }
            }
        }
    }

    fun clearChallenge() {
        mutableState.update { it.copy(challenge = null) }
    }

    fun consumeMessage() {
        mutableState.update { it.copy(message = null) }
    }

    private suspend fun applyExportFailure(
        failure: AccountExportOutcome.Failure,
        generation: Long,
    ) {
        if (!exportAccessIsCurrent(generation)) return
        if (failure.kind != AccountExportFailureKind.LOGIN_STATE) {
            updateExportState(generation) {
                it.copy(exportBusy = false, message = failure.message)
            }
            return
        }
        // A 401 only invalidates the generation that sent the request. Re-read
        // the authoritative local session before changing UI state so a slow
        // old response cannot visually log out a newer login either.
        val currentSession = repository.restoreSession()
        if (!exportAccessIsCurrent(generation)) return
        mutableState.update {
            it.copy(
                status = if (currentSession is AuthOutcome.Success && currentSession.value != null) {
                    AccountStatus.SIGNED_IN
                } else {
                    AccountStatus.GUEST
                },
                busy = false,
                exportBusy = false,
                identities = emptyList(),
                sessions = emptyList(),
                export = null,
                message = if (currentSession is AuthOutcome.Success && currentSession.value != null) {
                    "本次请求使用的旧登录状态已失效，请刷新后重试"
                } else {
                    failure.message
                },
            )
        }
    }

    private suspend fun signedIn(
        @Suppress("UNUSED_PARAMETER") session: LocalAuthSession,
        generation: Long,
    ) {
        if (!remoteAccessIsCurrent(generation)) return
        cancelExportJob()
        updateRemoteState(generation) {
            it.copy(
                status = AccountStatus.SIGNED_IN,
                busy = false,
                challenge = null,
                identities = emptyList(),
                sessions = emptyList(),
                export = null,
                exportBusy = false,
                includeBehaviorHistory = true,
                message = "登录成功",
            )
        }
        if (remoteAccessIsCurrent(generation)) {
            refreshSecurityData(allowCurrentAction = true)
        }
    }

    private fun beginWechatAuthorization(
        purpose: OAuthPurpose,
        phoneChallengeId: String? = null,
        phoneOtpCode: String? = null,
    ) {
        if (!wechatPurposeIsReady(purpose) || pendingWechatAction != null) return
        launchRemoteAction { generation ->
            updateRemoteState(generation) { it.copy(busy = true, message = null) }
            when (
                val stateOutcome = repository.createOAuthState(
                    provider = AuthIdentityType.WECHAT,
                    purpose = purpose,
                    phoneChallengeId = phoneChallengeId,
                )
            ) {
                is AuthOutcome.Failure -> updateRemoteState(generation) {
                    it.copy(busy = false, message = stateOutcome.message)
                }
                is AuthOutcome.Success -> {
                    if (!remoteAccessIsCurrent(generation) || !wechatPurposeIsReady(purpose)) {
                        return@launchRemoteAction
                    }
                    val expiresAt = runCatching { Instant.parse(stateOutcome.value.expiresAt) }.getOrNull()
                    if (expiresAt == null) {
                        updateRemoteState(generation) {
                            it.copy(busy = false, message = "微信授权状态未通过安全校验")
                        }
                        return@launchRemoteAction
                    }
                    val action = PendingWechatAction(
                        purpose = purpose,
                        phoneChallengeId = phoneChallengeId,
                        phoneOtpCode = phoneOtpCode,
                    )
                    pendingWechatAction = action
                    when (
                        val start = try {
                            wechatOAuth.beginAuthorization(
                                purpose = purpose,
                                state = stateOutcome.value.state,
                                expiresAt = expiresAt,
                            )
                        } catch (error: CancellationException) {
                            if (pendingWechatAction === action) pendingWechatAction = null
                            throw error
                        }
                    ) {
                        WechatOAuthStartResult.Started -> Unit
                        is WechatOAuthStartResult.Failed -> {
                            pendingWechatAction = null
                            updateRemoteState(generation) {
                                it.copy(busy = false, message = start.reason.userMessage())
                            }
                        }
                    }
                }
            }
        }
    }

    private fun beginQqAuthorization(
        activity: Activity,
        purpose: OAuthPurpose,
    ) = beginQqAuthorization(activity.toQqLoginHost(), purpose)

    private fun beginQqAuthorization(
        host: QqLoginHost,
        purpose: OAuthPurpose,
    ) {
        if (
            purpose !in setOf(OAuthPurpose.LOGIN, OAuthPurpose.BIND) ||
            !qqCapabilityIsReady() ||
            pendingQqAction != null
        ) return
        launchRemoteAction { generation ->
            updateRemoteState(generation) { it.copy(busy = true, message = null) }
            when (
                val stateOutcome = repository.createOAuthState(
                    provider = AuthIdentityType.QQ,
                    purpose = purpose,
                )
            ) {
                is AuthOutcome.Failure -> updateRemoteState(generation) {
                    it.copy(busy = false, message = stateOutcome.message)
                }
                is AuthOutcome.Success -> {
                    if (!remoteAccessIsCurrent(generation) || !qqCapabilityIsReady()) {
                        return@launchRemoteAction
                    }
                    val expiresAt = runCatching { Instant.parse(stateOutcome.value.expiresAt) }.getOrNull()
                    if (expiresAt == null) {
                        updateRemoteState(generation) {
                            it.copy(busy = false, message = "QQ 授权状态未通过安全校验")
                        }
                        return@launchRemoteAction
                    }
                    val action = PendingQqAction(purpose)
                    pendingQqAction = action
                    when (
                        val start = try {
                            qqOAuth.beginAuthorization(
                                host = host,
                                purpose = purpose,
                                state = stateOutcome.value.state,
                                expiresAt = expiresAt,
                            )
                        } catch (error: CancellationException) {
                            if (pendingQqAction === action) pendingQqAction = null
                            throw error
                        }
                    ) {
                        QqOAuthStartResult.Started -> Unit
                        is QqOAuthStartResult.Failed -> {
                            pendingQqAction = null
                            updateRemoteState(generation) {
                                it.copy(busy = false, message = start.reason.userMessage())
                            }
                        }
                    }
                }
            }
        }
    }

    private fun handleWechatEvent(event: WechatOAuthEvent) {
        if (event is WechatOAuthEvent.Failed && event.reason == WechatOAuthFailure.PRIVACY_REQUIRED) {
            revokeRemoteActions(preserveExternalAuthorization = false)
            return
        }
        if (!runtimeAppVersionGate.currentState.remoteFeaturesAllowed) {
            if (runtimeAppVersionGate.currentState.status ==
                RuntimeAppVersionGate.Status.UPDATE_REQUIRED
            ) rejectWechatEvent()
            else stageWechatEvent(event)
            return
        }
        when (configPhase) {
            AccountConfigPhase.LOADING -> stageWechatEvent(event)
            AccountConfigPhase.READY -> {
                if (wechatCapabilityIsReady()) {
                    consumeWechatEvent(event)
                } else {
                    rejectWechatEvent()
                }
            }
            AccountConfigPhase.UNAVAILABLE,
            AccountConfigPhase.INCOMPATIBLE,
            -> rejectWechatEvent()
        }
    }

    private fun handleQqEvent(event: QqOAuthEvent) {
        if (event is QqOAuthEvent.Failed && event.reason == QqOAuthFailure.PRIVACY_REQUIRED) {
            revokeRemoteActions(preserveExternalAuthorization = false)
            return
        }
        if (!runtimeAppVersionGate.currentState.remoteFeaturesAllowed) {
            if (runtimeAppVersionGate.currentState.status ==
                RuntimeAppVersionGate.Status.UPDATE_REQUIRED
            ) rejectQqEvent(event)
            else stageQqEvent(event)
            return
        }
        when (configPhase) {
            AccountConfigPhase.LOADING -> stageQqEvent(event)
            AccountConfigPhase.READY -> {
                if (qqCapabilityIsReady()) {
                    consumeQqEvent(event)
                } else {
                    rejectQqEvent(event)
                }
            }
            AccountConfigPhase.UNAVAILABLE,
            AccountConfigPhase.INCOMPATIBLE,
            -> rejectQqEvent(event)
        }
    }

    private fun stageWechatEvent(event: WechatOAuthEvent) {
        if (stagedWechatEvent == null) {
            stagedWechatEvent = event
        } else if (event is WechatOAuthEvent.Authorized) {
            event.discardProof()
        }
        mutableState.update { it.copy(busy = false) }
    }

    private fun stageQqEvent(event: QqOAuthEvent) {
        if (stagedQqEvent == null) {
            stagedQqEvent = event
        } else if (event is QqOAuthEvent.Authorized) {
            event.discardProof()
        }
        mutableState.update { it.copy(busy = false) }
    }

    private fun resumeStagedAuthorization(): Boolean {
        stagedWechatEvent?.let { event ->
            stagedWechatEvent = null
            handleWechatEvent(event)
            return true
        }
        stagedQqEvent?.let { event ->
            stagedQqEvent = null
            handleQqEvent(event)
            return true
        }
        return false
    }

    private fun consumeWechatEvent(event: WechatOAuthEvent) {
        when (event) {
            is WechatOAuthEvent.Failed -> {
                pendingWechatAction = null
                mutableState.update {
                    it.copy(busy = false, message = event.reason.userMessage())
                }
            }
            is WechatOAuthEvent.Authorized -> {
                val action = pendingWechatAction.also { pendingWechatAction = null }
                if (
                    action == null ||
                    action.purpose != event.purpose ||
                    !wechatPurposeIsReady(event.purpose)
                ) {
                    event.discardProof()
                    mutableState.update {
                        it.copy(busy = false, message = "微信授权流程已失效，请重新发起")
                    }
                    return
                }
                val launched = launchRemoteAction(allowBusy = true) { generation ->
                    updateRemoteState(generation) { it.copy(busy = true, message = null) }
                    when (event.purpose) {
                        OAuthPurpose.LOGIN -> {
                            val outcome = event.consumeProof { state, authorizationCode ->
                                cancelExportJob()
                                repository.loginWithWechat(state, authorizationCode)
                            }
                            when (outcome) {
                                is AuthOutcome.Success -> signedIn(outcome.value, generation)
                                is AuthOutcome.Failure -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = outcome.message)
                                }
                                null -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = "微信授权流程已使用，请重新发起")
                                }
                            }
                        }
                        OAuthPurpose.REGISTER -> {
                            val challengeId = action.phoneChallengeId
                            val otpCode = action.phoneOtpCode
                            if (challengeId == null || otpCode == null) {
                                event.discardProof()
                                updateRemoteState(generation) {
                                    it.copy(
                                        busy = false,
                                        message = "手机号与微信注册流程已失效，请重新开始",
                                    )
                                }
                                return@launchRemoteAction
                            }
                            val outcome = event.consumeProof { state, authorizationCode ->
                                cancelExportJob()
                                repository.registerPhoneWechat(
                                    challengeId = challengeId,
                                    otpCode = otpCode,
                                    oauthState = state,
                                    authorizationCode = authorizationCode,
                                )
                            }
                            when (outcome) {
                                is AuthOutcome.Success -> signedIn(outcome.value, generation)
                                is AuthOutcome.Failure -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = outcome.message)
                                }
                                null -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = "微信授权流程已使用，请重新发起")
                                }
                            }
                        }
                        OAuthPurpose.BIND -> {
                            event.discardProof()
                            updateRemoteState(generation) {
                                it.copy(busy = false, message = "Android 1.0 不支持绑定微信")
                            }
                        }
                    }
                }
                if (!launched) rejectWechatEvent(event)
            }
        }
    }

    private fun consumeQqEvent(event: QqOAuthEvent) {
        when (event) {
            is QqOAuthEvent.Failed -> {
                pendingQqAction = null
                mutableState.update {
                    it.copy(busy = false, message = event.reason.userMessage())
                }
            }
            is QqOAuthEvent.Authorized -> {
                val action = pendingQqAction.also { pendingQqAction = null }
                if (
                    action == null ||
                    action.purpose != event.purpose ||
                    !qqCapabilityIsReady()
                ) {
                    rejectQqEvent(event)
                    return
                }
                val launched = launchRemoteAction(allowBusy = true) { generation ->
                    updateRemoteState(generation) { it.copy(busy = true, message = null) }
                    when (event.purpose) {
                        OAuthPurpose.LOGIN -> {
                            val outcome = event.consumeProof { state, accessToken ->
                                cancelExportJob()
                                repository.loginWithQq(state, accessToken)
                            }
                            when (outcome) {
                                is AuthOutcome.Success -> signedIn(outcome.value, generation)
                                is AuthOutcome.Failure -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = outcome.message)
                                }
                                null -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = "QQ 授权流程已使用，请重新发起")
                                }
                            }
                        }
                        OAuthPurpose.BIND -> {
                            val outcome = event.consumeProof { state, accessToken ->
                                repository.bindWithQq(state, accessToken)
                            }
                            when (outcome) {
                                is AuthOutcome.Success -> {
                                    updateRemoteState(generation) {
                                        it.copy(busy = false, message = "QQ 身份已安全绑定")
                                    }
                                    if (remoteAccessIsCurrent(generation)) {
                                        refreshSecurityData(allowCurrentAction = true)
                                    }
                                }
                                is AuthOutcome.Failure -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = outcome.message)
                                }
                                null -> updateRemoteState(generation) {
                                    it.copy(busy = false, message = "QQ 授权流程已使用，请重新发起")
                                }
                            }
                        }
                        OAuthPurpose.REGISTER -> {
                            event.discardProof()
                            updateRemoteState(generation) {
                                it.copy(busy = false, message = "QQ 不能用于创建新账号")
                            }
                        }
                    }
                }
                if (!launched) rejectQqEvent(event)
            }
        }
    }

    private fun rejectWechatEvent(event: WechatOAuthEvent? = null) {
        if (event is WechatOAuthEvent.Authorized) event.discardProof()
        (stagedWechatEvent as? WechatOAuthEvent.Authorized)?.discardProof()
        pendingWechatAction = null
        stagedWechatEvent = null
        wechatOAuth.cancelAuthorization()
        mutableState.update { it.copy(busy = false) }
    }

    private fun rejectQqEvent(event: QqOAuthEvent? = null) {
        if (event is QqOAuthEvent.Authorized) event.discardProof()
        (stagedQqEvent as? QqOAuthEvent.Authorized)?.discardProof()
        pendingQqAction = null
        stagedQqEvent = null
        qqOAuth.cancelAuthorization()
        mutableState.update { it.copy(busy = false) }
    }

    private fun clearExternalAuthorization() {
        rejectWechatEvent()
        rejectQqEvent()
    }

    private fun discardAuthorizationsDisabledByLatestConfig() {
        val wechatPurpose = pendingWechatAction?.purpose
        if (
            !wechatCapabilityIsReady() ||
            wechatPurpose != null && !wechatPurposeIsReady(wechatPurpose)
        ) {
            rejectWechatEvent()
        }
        if (!qqCapabilityIsReady()) rejectQqEvent()
    }

    private fun authenticatedMutation(
        successMessage: String,
        operation: suspend () -> AuthOutcome<Unit>,
    ) {
        if (mutableState.value.status != AccountStatus.SIGNED_IN) return
        launchRemoteAction { generation ->
            updateRemoteState(generation) { it.copy(busy = true, message = null) }
            when (val outcome = operation()) {
                is AuthOutcome.Success -> {
                    updateRemoteState(generation) {
                        it.copy(busy = false, message = successMessage)
                    }
                    if (remoteAccessIsCurrent(generation)) {
                        refreshSecurityData(allowCurrentAction = true)
                    }
                }
                is AuthOutcome.Failure -> updateRemoteState(generation) {
                    it.copy(busy = false, message = outcome.message)
                }
            }
        }
    }

    override fun onCleared() {
        // Challenges and messages are deliberately memory-only and disappear
        // with this navigation-scoped ViewModel.
        pendingWechatAction = null
        pendingQqAction = null
        (stagedWechatEvent as? WechatOAuthEvent.Authorized)?.discardProof()
        stagedWechatEvent = null
        (stagedQqEvent as? QqOAuthEvent.Authorized)?.discardProof()
        stagedQqEvent = null
        remoteAccessGeneration += 1
        remoteActionJob?.cancel()
        remoteActionJob = null
        logoutJob?.cancel()
        logoutJob = null
        dataRightsJob?.cancel()
        dataRightsJob = null
        exportJob?.cancel()
        exportJob = null
        wechatOAuth.cancelAuthorization()
        qqOAuth.cancelAuthorization()
        mutableState.value = AccountUiState(
            status = AccountStatus.GUEST,
            wechatClientConfigured = wechatOAuth.clientConfigured,
            qqClientConfigured = qqOAuth.clientConfigured,
        )
        super.onCleared()
    }

    private fun launchExportJob(operation: suspend (generation: Long) -> Unit) {
        val unfinishedExport = exportJob?.isCompleted == false
        if (!accountsAccessIsReady() || !mutableState.value.dataExportEnabled || unfinishedExport) {
            return
        }
        val generation = exportAccessGeneration
        mutableState.update { it.copy(exportBusy = true, message = null) }
        val launched = viewModelScope.launch { operation(generation) }
        exportJob = launched
        launched.invokeOnCompletion {
            if (exportJob === launched) {
                exportJob = null
                if (exportAccessIsCurrent(generation)) {
                    mutableState.update { it.copy(exportBusy = false) }
                }
            }
        }
    }

    private suspend fun cancelExportJob() {
        exportAccessGeneration += 1
        val active = exportJob
        if (active != null) {
            active.cancelAndJoin()
            if (exportJob === active) exportJob = null
        }
        mutableState.update {
            it.copy(
                exportBusy = false,
                export = null,
                includeBehaviorHistory = true,
            )
        }
    }

    /**
     * A download cleans its partial destination from a NonCancellable finally
     * block. Keep the old job registered until that cleanup has completed, so
     * a fast disable/enable sequence cannot start a second export operation in
     * parallel or bypass the cleanup.
     */
    private fun finishCapabilityRevocation(revokedJob: Job) {
        viewModelScope.launch {
            revokedJob.join()
            if (exportJob === revokedJob) exportJob = null
            if (
                mutableState.value.dataExportEnabled &&
                exportJob?.isCompleted != false
            ) {
                mutableState.update { it.copy(exportBusy = false) }
                refreshExport(showMessage = false)
            }
        }
    }

    private fun exportAccessIsCurrent(generation: Long): Boolean =
        generation == exportAccessGeneration &&
            accountsAccessIsReady() &&
            mutableState.value.dataExportEnabled


    private inline fun updateExportState(
        generation: Long,
        transform: (AccountUiState) -> AccountUiState,
    ) {
        if (!exportAccessIsCurrent(generation)) return
        mutableState.update { current ->
            if (exportAccessIsCurrent(generation)) transform(current) else current
        }
    }

    private fun AuthCodeChallenge.toPending(purpose: OtpPurpose): PendingOtpChallenge =
        PendingOtpChallenge(
            type = targetType,
            purpose = purpose,
            challengeId = challengeId,
            maskedTarget = maskedTarget,
            expiresAt = Instant.parse(expiresAt),
        )

    private fun otpCapabilityIsReady(type: AuthIdentityType, purpose: OtpPurpose): Boolean {
        val capabilities = activeCapabilities ?: return false
        if (!accountsAccessIsReady()) return false
        val providerEnabled = when (type) {
            AuthIdentityType.PHONE -> capabilities.phoneEnabled
            AuthIdentityType.EMAIL -> capabilities.emailEnabled
            else -> false
        }
        if (!providerEnabled) return false
        return when (purpose) {
            OtpPurpose.LOGIN -> true
            OtpPurpose.REGISTER ->
                type == AuthIdentityType.PHONE && capabilities.registrationEnabled
            OtpPurpose.BIND ->
                type == AuthIdentityType.EMAIL &&
                    mutableState.value.status == AccountStatus.SIGNED_IN
        }
    }

    private fun wechatCapabilityIsReady(): Boolean =
        accountsAccessIsReady() && activeCapabilities?.wechatEnabled == true

    private fun wechatPurposeIsReady(purpose: OAuthPurpose): Boolean {
        val capabilities = activeCapabilities ?: return false
        if (!wechatCapabilityIsReady()) return false
        return when (purpose) {
            OAuthPurpose.LOGIN -> true
            OAuthPurpose.BIND -> false
            OAuthPurpose.REGISTER ->
                capabilities.registrationEnabled && capabilities.phoneEnabled
        }
    }

    private fun qqCapabilityIsReady(): Boolean =
        accountsAccessIsReady() && activeCapabilities?.qqEnabled == true

    private class PendingWechatAction(
        val purpose: OAuthPurpose,
        val phoneChallengeId: String?,
        val phoneOtpCode: String?,
    ) {
        override fun toString(): String = "PendingWechatAction(purpose=$purpose)"
    }

    private class PendingQqAction(val purpose: OAuthPurpose) {
        override fun toString(): String = "PendingQqAction(purpose=$purpose)"
    }

    private fun WechatOAuthFailure.userMessage(): String = when (this) {
        WechatOAuthFailure.PRIVACY_REQUIRED -> "请先同意隐私政策后再使用微信授权"
        WechatOAuthFailure.CLIENT_NOT_CONFIGURED -> "此安装包尚未配置微信开放平台 AppID"
        WechatOAuthFailure.WECHAT_NOT_INSTALLED -> "本机未安装可用的微信客户端"
        WechatOAuthFailure.UNSUPPORTED_PURPOSE -> "当前版本不支持绑定微信"
        WechatOAuthFailure.USER_CANCELLED -> "已取消微信授权"
        WechatOAuthFailure.AUTHORIZATION_DENIED -> "微信授权未获同意"
        WechatOAuthFailure.BUSY -> "已有微信授权正在进行，请稍候"
        WechatOAuthFailure.STATE_EXPIRED,
        WechatOAuthFailure.NO_PENDING_AUTHORIZATION,
        WechatOAuthFailure.STATE_MISMATCH,
        WechatOAuthFailure.INVALID_SERVER_STATE,
        WechatOAuthFailure.INVALID_CALLBACK,
        -> "微信授权流程已失效，请重新发起"
        WechatOAuthFailure.SDK_REGISTRATION_FAILED,
        WechatOAuthFailure.AUTHORIZATION_LAUNCH_FAILED,
        -> "暂时无法调起微信授权，请稍后重试"
    }

    private fun QqOAuthFailure.userMessage(): String = when (this) {
        QqOAuthFailure.PRIVACY_REQUIRED -> "请先同意隐私政策后再使用 QQ 授权"
        QqOAuthFailure.CLIENT_NOT_CONFIGURED -> "此安装包尚未配置 QQ 互联 AppID"
        QqOAuthFailure.HOST_ACTIVITY_UNAVAILABLE -> "当前页面暂时无法调起 QQ，请重试"
        QqOAuthFailure.UNSUPPORTED_PURPOSE -> "QQ 只能用于登录已有账号或登录后绑定"
        QqOAuthFailure.USER_CANCELLED -> "已取消 QQ 授权"
        QqOAuthFailure.AUTHORIZATION_DENIED -> "QQ 授权未获同意"
        QqOAuthFailure.BUSY -> "已有 QQ 授权正在进行，请稍候"
        QqOAuthFailure.STATE_EXPIRED,
        QqOAuthFailure.NO_PENDING_AUTHORIZATION,
        QqOAuthFailure.INVALID_SERVER_STATE,
        QqOAuthFailure.INVALID_CALLBACK,
        -> "QQ 授权流程已失效，请重新发起"
        QqOAuthFailure.SDK_INITIALIZATION_FAILED,
        QqOAuthFailure.SDK_ERROR,
        QqOAuthFailure.AUTHORIZATION_LAUNCH_FAILED,
        -> "暂时无法完成 QQ 授权，请稍后重试"
    }

	private companion object {
		val OTP_CODE_PATTERN = Regex("^\\d{6}$")
	}

    private enum class AccountConfigPhase { LOADING, READY, UNAVAILABLE, INCOMPATIBLE }
}
