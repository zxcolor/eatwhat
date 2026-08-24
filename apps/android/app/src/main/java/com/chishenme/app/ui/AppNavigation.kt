package com.chishenme.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.chishenme.app.feature.decision.DecisionViewModel
import com.chishenme.app.feature.decision.RecommendationLoadState
import com.chishenme.app.feature.account.AccountScreen
import com.chishenme.app.feature.account.AccountStatus
import com.chishenme.app.feature.account.AccountViewModel
import com.chishenme.app.feature.detail.DetailSessionExpiredScreen
import com.chishenme.app.feature.detail.RestaurantDetailScreen
import com.chishenme.app.feature.home.HomeScreen
import com.chishenme.app.feature.results.ResultsScreen
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import com.chishenme.app.feature.session.ResultSessionState
import com.chishenme.app.feature.settings.SettingsScreen
import com.chishenme.app.feature.settings.SettingsViewModel
import com.chishenme.app.feature.support.SupportFeedbackScreen
import com.chishenme.app.feature.support.SupportFeedbackViewModel
import com.chishenme.app.feature.saved.SavedResourcesScreen
import com.chishenme.app.feature.saved.SavedResourcesViewModel
import com.chishenme.app.feature.update.UpdateRequiredScreen
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.RecommendationEventType

private object Routes {
    const val Home = "home"
    const val Results = "results"
    const val Detail = "restaurant-detail"
    const val Settings = "settings"
    const val Account = "account"
    const val SavedResources = "saved-resources"
    const val SupportFeedback = "support-feedback"
}

@Composable
fun AppNavigation(
    onWithdrawPrivacy: () -> Unit,
    decisionViewModel: DecisionViewModel = hiltViewModel(),
) {
    val decisionState by decisionViewModel.uiState.collectAsStateWithLifecycle()
    val runtimeVersionGateState by
        decisionViewModel.runtimeAppVersionGate.state.collectAsStateWithLifecycle()
    val effectiveFeatureConfig = effectiveRuntimeFeatureConfig(
        decisionState.remoteFeatureConfig,
        runtimeVersionGateState,
    )
    val accountFeatureConfig = runtimeGatedRemoteFeatureConfig(
        decisionState.remoteFeatureConfig,
        runtimeVersionGateState,
    )
    val lifecycleOwner = LocalLifecycleOwner.current
    val supportFeedbackEnabled = effectiveFeatureConfig?.supportFeedbackEnabled == true
    val refreshConfigAndInvalidateResultSessions: () -> Unit = {
        decisionViewModel.clearSelectedResult()
        decisionViewModel.startConsentSession()
    }

    LaunchedEffect(decisionViewModel) {
        decisionViewModel.ensureConsentSessionStarted()
    }
    DisposableEffect(lifecycleOwner, decisionViewModel) {
        // Adding an observer to an already-started Lifecycle immediately replays
        // ON_START. Only an ON_START preceded by an observed ON_STOP is a real
        // foreground return; the initial request remains owned by LaunchedEffect.
        val foregroundRefreshGate = ForegroundConfigRefreshGate()
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> foregroundRefreshGate.onStopped()
                Lifecycle.Event.ON_START -> if (foregroundRefreshGate.onStarted()) {
                    refreshConfigAndInvalidateResultSessions()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(runtimeVersionGateState.status) {
        if (runtimeVersionGateState.status == RuntimeAppVersionGate.Status.UPDATE_REQUIRED) {
            decisionViewModel.clearSelectedResult()
        }
    }

    val withdrawPrivacy: () -> Unit = {
        decisionViewModel.clearSelectedResult()
        decisionViewModel.clearForPrivacyWithdrawal()
        onWithdrawPrivacy()
    }

    if (runtimeVersionGateState.status == RuntimeAppVersionGate.Status.UPDATE_REQUIRED) {
        val dataRightsViewModel: AccountViewModel = hiltViewModel()
        val dataRightsState by dataRightsViewModel.state.collectAsStateWithLifecycle()
        LaunchedEffect(dataRightsViewModel, runtimeVersionGateState.status) {
            dataRightsViewModel.startDataRightsOnly()
        }
        UpdateRequiredScreen(
            minimumSupportedVersion = runtimeVersionGateState.minimumSupportedVersion,
            dataRightsChecking = dataRightsState.status == AccountStatus.CHECKING ||
                dataRightsState.busy,
            signedInForDataRights = dataRightsState.status == AccountStatus.SIGNED_IN,
            localSessionMaterialPresent = dataRightsState.localSessionMaterialPresent,
            dataRightsMessage = dataRightsState.message,
            onRecheck = refreshConfigAndInvalidateResultSessions,
            onLocalLogout = dataRightsViewModel::logout,
            onDeleteAccount = dataRightsViewModel::deleteAccount,
            onRetryDataRights = dataRightsViewModel::startDataRightsOnly,
            onWithdrawPrivacy = withdrawPrivacy,
        )
        return
    }

    // This call site leaves composition while UPDATE_REQUIRED is shown. A later
    // compatible recheck therefore creates a fresh controller at Home instead
    // of reviving an old account/detail back stack.
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = Routes.Home) {
        composable(Routes.Home) {
            HomeScreen(
                state = decisionState,
                viewModel = decisionViewModel,
                onOpenSettings = { navController.navigate(Routes.Settings) },
                onReconnectService = refreshConfigAndInvalidateResultSessions,
                onRecommendationStarted = { navController.navigate(Routes.Results) },
            )
        }
        composable(Routes.Results) {
            ResultsScreen(
                state = decisionState,
                onBack = { navController.popBackStack() },
                onRetry = decisionViewModel::retry,
                onReroll = decisionViewModel::reroll,
                onOpenDetail = { result ->
                    val ready = decisionViewModel.uiState.value.loadState
                        as? RecommendationLoadState.Ready
                    if (ready?.trustedCompatibleConfiguration == true &&
                        ready.response.results.any { it.resultToken == result.resultToken } &&
                        decisionViewModel.recommendationSessionState(result.resultToken) ==
                        ResultSessionState.CURRENT &&
                        decisionViewModel.selectResultForDetail(result.resultToken)
                    ) {
                        runCatching { navController.navigate(Routes.Detail) }
                            .onSuccess {
                                decisionViewModel.recordEvent(result, RecommendationEventType.DETAIL)
                            }
                            .onFailure { decisionViewModel.clearSelectedResult() }
                    }
                },
            )
        }
        composable(Routes.Detail) {
            val persistenceViewModel: SavedResourcesViewModel = hiltViewModel()
            val persistenceState by persistenceViewModel.state.collectAsStateWithLifecycle()
            LaunchedEffect(decisionState.remoteFeatureConfig, runtimeVersionGateState) {
                persistenceViewModel.applyCapabilities(
                    effectiveFeatureConfig,
                    runtimeVersionGateState.trustedConfigurationGeneration,
                )
            }
            val closeDetail: () -> Unit = {
                if (navController.popBackStack()) decisionViewModel.clearSelectedResult()
            }
            val result = decisionViewModel.selectedResultForDetail()
            val ready = decisionState.loadState as? RecommendationLoadState.Ready
            val resultSessionState = result?.let {
                decisionViewModel.recommendationSessionState(it.resultToken)
            }
            if (result == null || ready == null || !ready.trustedCompatibleConfiguration ||
                resultSessionState != ResultSessionState.CURRENT ||
                ready.response.results.none {
                    it.resultToken == result.resultToken
                }
            ) {
                DetailSessionExpiredScreen(onBack = closeDetail)
            } else {
                RestaurantDetailScreen(
                    result = result,
                    resultSessionState = resultSessionState,
                    resultSessionStateProvider = {
                        decisionViewModel.recommendationSessionState(result.resultToken)
                    },
                    persistenceState = persistenceState,
                    onBack = closeDetail,
                    onEvent = { type -> decisionViewModel.recordEvent(result, type) },
                    onFavorite = { group ->
                        if (decisionViewModel.recommendationSessionState(result.resultToken) ==
                            ResultSessionState.CURRENT
                        ) {
                            persistenceViewModel.createFavorite(
                                effectiveFeatureConfig,
                                ready.response,
                                result,
                                group,
                            )
                        }
                    },
                    onPrivateFeedback = { type ->
                        if (decisionViewModel.recommendationSessionState(result.resultToken) ==
                            ResultSessionState.CURRENT
                        ) {
                            persistenceViewModel.createPrivateFeedback(
                                effectiveFeatureConfig,
                                ready.response,
                                result,
                                type,
                            )
                        }
                    },
                    onOpenAccount = { navController.navigate(Routes.Account) },
                    onConsumePersistenceMessage = persistenceViewModel::consumeMessage,
                )
            }
        }
        composable(Routes.Settings) {
            // Settings state is not needed by the launch/home flow. Scope its
            // ViewModel and collectors to this destination so DataStore/history
            // work starts only when the user opens Settings.
            val settingsViewModel: SettingsViewModel = hiltViewModel()
            val aiEnabled by settingsViewModel.aiEnabled.collectAsStateWithLifecycle()
            val theme by settingsViewModel.theme.collectAsStateWithLifecycle()
            val decisionHistory by settingsViewModel.decisionHistory.collectAsStateWithLifecycle()

            SettingsScreen(
                aiEnabled = aiEnabled,
                aiServiceAvailable = effectiveFeatureConfig?.aiEnabled == true,
                theme = theme,
                onAiEnabledChange = settingsViewModel::setAiEnabled,
                onThemeChange = settingsViewModel::setTheme,
                onBack = { navController.popBackStack() },
                decisionHistory = decisionHistory,
                onClearDecisionHistory = settingsViewModel::clearDecisionHistory,
                onOpenAccount = { navController.navigate(Routes.Account) },
                onOpenSavedResources = { navController.navigate(Routes.SavedResources) },
                onOpenSupportFeedback = {
                    if (supportFeedbackEnabled) {
                        navController.navigate(Routes.SupportFeedback)
                    }
                },
                supportFeedbackEnabled = supportFeedbackEnabled,
                minimumSupportedVersion = effectiveFeatureConfig?.minimumSupportedVersion,
                onWithdrawPrivacy = withdrawPrivacy,
            )
        }
        composable(Routes.Account) {
            val accountViewModel: AccountViewModel = hiltViewModel()
            val accountState by accountViewModel.state.collectAsStateWithLifecycle()
            AccountScreen(
                state = accountState,
                remoteFeatureConfig = accountFeatureConfig,
                viewModel = accountViewModel,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.SavedResources) {
            val savedViewModel: SavedResourcesViewModel = hiltViewModel()
            val savedState by savedViewModel.state.collectAsStateWithLifecycle()
            LaunchedEffect(decisionState.remoteFeatureConfig, runtimeVersionGateState) {
                savedViewModel.start(
                    effectiveFeatureConfig,
                    runtimeVersionGateState.trustedConfigurationGeneration,
                )
            }
            SavedResourcesScreen(
                state = savedState,
                viewModel = savedViewModel,
                onBack = { navController.popBackStack() },
                onOpenAccount = { navController.navigate(Routes.Account) },
            )
        }
        composable(Routes.SupportFeedback) {
            val supportViewModel: SupportFeedbackViewModel = hiltViewModel()
            val supportState by supportViewModel.state.collectAsStateWithLifecycle()
            LaunchedEffect(supportFeedbackEnabled) {
                supportViewModel.start(supportFeedbackEnabled)
            }
            SupportFeedbackScreen(
                state = supportState,
                serverCapabilityEnabled = supportFeedbackEnabled,
                viewModel = supportViewModel,
                onBack = { navController.popBackStack() },
            )
        }
    }
}

internal fun effectiveRuntimeFeatureConfig(
    remote: RemoteFeatureConfigState,
    gate: RuntimeAppVersionGate.State,
): FeatureConfig? {
    val ready = remote as? RemoteFeatureConfigState.Ready ?: return null
    return ready.config.takeIf {
        gate.remoteFeaturesAllowed && gate.trustedConfigurationGeneration == ready.generation
    }
}

internal fun runtimeGatedRemoteFeatureConfig(
    remote: RemoteFeatureConfigState,
    gate: RuntimeAppVersionGate.State,
): RemoteFeatureConfigState = when {
    effectiveRuntimeFeatureConfig(remote, gate) != null -> remote
    remote is RemoteFeatureConfigState.Ready -> RemoteFeatureConfigState.Loading(remote.generation)
    else -> remote
}

internal class ForegroundConfigRefreshGate {
    private var stoppedSinceLastStart = false

    fun onStopped() {
        stoppedSinceLastStart = true
    }

    fun onStarted(): Boolean {
        if (!stoppedSinceLastStart) return false
        stoppedSinceLastStart = false
        return true
    }
}
