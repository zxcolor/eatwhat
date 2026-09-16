package com.chishenme.app.feature.account

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.AccountExportStatus
import com.chishenme.app.data.remote.AccountExportStatusResponse
import com.chishenme.app.data.remote.AuthIdentityBinding
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthSessionSummary
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.config.configOrNull
import com.chishenme.app.feature.consent.ConsentDocument
import com.chishenme.app.feature.consent.DocumentDialog
import com.chishenme.app.ui.AppBadge
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppDialog
import com.chishenme.app.ui.AppHeroCard
import com.chishenme.app.ui.AppIconTile
import com.chishenme.app.ui.AppPrimaryButton
import com.chishenme.app.ui.AppSectionHeader
import com.chishenme.app.ui.AppSnackbarHost
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone
import com.chishenme.app.ui.AppTopBar
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(
    state: AccountUiState,
    remoteFeatureConfig: RemoteFeatureConfigState,
    viewModel: AccountViewModel,
    onBack: () -> Unit,
) {
    val capabilities = remoteFeatureConfig.configOrNull?.authCapabilities
    val lifecycleOwner = LocalLifecycleOwner.current
    val snackbar = remember { SnackbarHostState() }
    val noticeScope = rememberCoroutineScope()
    var showPrivacy by remember { mutableStateOf(false) }
    val accountListState = rememberLazyListState()
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    var settledAccountStatus by remember { mutableStateOf<AccountStatus?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var pendingUnbind by remember { mutableStateOf<AuthIdentityBinding?>(null) }
    var pendingRevoke by remember { mutableStateOf<AuthSessionSummary?>(null) }
    val hostActivity = LocalContext.current.findActivity()
    val createExportDocument = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/json"),
    ) { uri ->
        if (uri != null && capabilities?.dataExportEnabled == true) {
            viewModel.downloadExport(uri.toString())
        }
    }

    LaunchedEffect(remoteFeatureConfig) {
        if (capabilities?.accountsEnabled != true) {
            pendingUnbind = null
            pendingRevoke = null
            confirmDelete = false
        }
        viewModel.start(remoteFeatureConfig)
    }

    DisposableEffect(lifecycleOwner, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                viewModel.suspendRemoteAccessForForegroundRefresh()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    LaunchedEffect(state.message) {
        state.message?.let { message ->
            val challengeConfirmation = state.challenge?.let { "验证码已发送至 ${it.maskedTarget}" }
            if (message != challengeConfirmation) {
                snackbar.showSnackbar(message)
            }
            viewModel.consumeMessage()
        }
    }

    LaunchedEffect(state.status) {
        if (state.status == AccountStatus.GUEST || state.status == AccountStatus.SIGNED_IN) {
            if (settledAccountStatus != null && settledAccountStatus != state.status) {
                focusManager.clearFocus()
                keyboardController?.hide()
                accountListState.scrollToItem(0)
            }
            settledAccountStatus = state.status
        }
    }

    val authLandingVisible = state.status == AccountStatus.GUEST && capabilities?.accountsEnabled == true ||
        state.status == AccountStatus.SIGNED_IN && state.entryMode == AccountEntryMode.REGISTER
    if (authLandingVisible) {
        AccountAuthLanding(
            state = state,
            capabilities = capabilities,
            qqHostAvailable = hostActivity != null,
            snackbar = snackbar,
            actions = AuthLandingActions(
                onBack = {
                    if (state.entryMode == AccountEntryMode.REGISTER && state.status == AccountStatus.GUEST && !state.busy) {
                        viewModel.showLogin()
                    } else {
                        viewModel.finishRegistration()
                        onBack()
                    }
                },
                onPrivacy = { showPrivacy = true },
                onRequestCode = { type, target ->
                    viewModel.requestCode(
                        type,
                        if (type == AuthIdentityType.PHONE) OtpPurpose.REGISTER else OtpPurpose.LOGIN,
                        target,
                    )
                },
                onSubmit = viewModel::submitLoginCode,
                onResend = viewModel::resendCode,
                onResetChallenge = viewModel::clearChallenge,
                onSelectType = { type ->
                    viewModel.clearChallenge()
                    viewModel.selectOtpInputType(type)
                },
                onTargetChange = viewModel::updateOtpTargetDraft,
                onOtpChange = viewModel::updateOtpCodeDraft,
                onLogin = viewModel::showLogin,
                onRegister = viewModel::showRegistration,
                onWechatLogin = {
                    viewModel.clearChallenge()
                    viewModel.startWechatLogin()
                },
                onQqLogin = {
                    viewModel.clearChallenge()
                    hostActivity?.let(viewModel::startQqLogin)
                },
                onWechatBind = viewModel::startWechatBind,
                onRefreshIdentities = viewModel::refreshSecurityData,
                onFinish = {
                    viewModel.finishRegistration()
                    onBack()
                },
                onNotice = { message -> noticeScope.launch { snackbar.showSnackbar(message) } },
            ),
        )
        if (showPrivacy) {
            AuthSurfaceTheme {
                DocumentDialog(ConsentDocument.PRIVACY) { showPrivacy = false }
            }
        }
        return
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            AppTopBar(
                title = "账号与安全",
                subtitle = "身份、设备与数据权利",
                onBack = onBack,
                navigationContentDescription = "返回",
            )
        },
        snackbarHost = { AppSnackbarHost(snackbar) },
    ) { padding ->
        LazyColumn(
            state = accountListState,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding(),
            contentPadding = PaddingValues(
                horizontal = AppDimens.ScreenHorizontal,
                vertical = AppDimens.ScreenVertical,
            ),
            verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
        ) {
            when {
                remoteFeatureConfig is RemoteFeatureConfigState.Loading &&
                    state.status != AccountStatus.SIGNED_IN -> item {
                    AccountServiceGateCard(remoteFeatureConfig)
                }
                remoteFeatureConfig is RemoteFeatureConfigState.Unavailable &&
                    state.status != AccountStatus.SIGNED_IN -> item {
                    AccountServiceGateCard(remoteFeatureConfig)
                }
                remoteFeatureConfig is RemoteFeatureConfigState.Incompatible &&
                    state.status != AccountStatus.SIGNED_IN -> item {
                    AccountServiceGateCard(remoteFeatureConfig)
                }
                capabilities?.accountsEnabled != true && state.status != AccountStatus.SIGNED_IN -> item {
                    AccountServiceGateCard(remoteFeatureConfig)
                }
                state.status == AccountStatus.CHECKING -> item {
                    AccountSessionCheckingCard()
                }
                else -> {
                    val activeCapabilities = capabilities?.takeIf { it.accountsEnabled }
                    val securityDataLoading = state.busy &&
                        state.identities.isEmpty() &&
                        state.sessions.isEmpty() &&
                        state.authStep == AccountAuthStep.CHOOSE
                    val identitiesReady = state.identities.isNotEmpty()

                    item {
                        SignedInCard(
                            identities = state.identities.size,
                            sessions = state.sessions.size,
                            onRefresh = viewModel::refreshSecurityData,
                            busy = state.busy,
                        )
                    }
                    if (state.busy) {
                        item { AccountBusyBanner(state) }
                    }
                    if (activeCapabilities != null) {
                        item {
                            SecurityOverviewCard(
                                identities = state.identities.size,
                                sessions = state.sessions.size,
                                loading = securityDataLoading,
                            )
                        }
                        item {
                            IdentityCard(
                                identities = state.identities,
                                loading = securityDataLoading,
                                busy = state.busy,
                                onUnbind = { pendingUnbind = it },
                            )
                        }
                        item {
                            AddLoginMethodsCard(
                                dataReady = identitiesReady,
                                state = state,
                                capabilities = activeCapabilities,
                                hostAvailable = hostActivity != null,
                                onRequestEmailCode = { email ->
                                    viewModel.requestCode(AuthIdentityType.EMAIL, OtpPurpose.BIND, email)
                                },
                                onSubmitEmailCode = viewModel::submitBindCode,
                                onResend = viewModel::resendCode,
                                onReset = viewModel::clearChallenge,
                                onEmailChange = {
                                    viewModel.updateOtpTargetDraft(AuthIdentityType.EMAIL, it)
                                },
                                onOtpChange = viewModel::updateOtpCodeDraft,
                                onWechatBind = viewModel::startWechatBind,
                                onQqBind = { hostActivity?.let(viewModel::startQqBind) },
                            )
                        }
                        item {
                            SessionsCard(
                                sessions = state.sessions,
                                loading = securityDataLoading,
                                busy = state.busy,
                                onRevoke = { pendingRevoke = it },
                            )
                        }
                    } else {
                        item { SignedInServiceUnavailableCard(remoteFeatureConfig) }
                    }
                    item {
                        DataRightsCard(
                            export = state.export,
                            dataExportEnabled = showAccountExportControls(
                                serverDataExportEnabled = activeCapabilities?.dataExportEnabled == true,
                                viewModelDataExportEnabled = state.dataExportEnabled,
                            ),
                            includeBehaviorHistory = state.includeBehaviorHistory,
                            controlsBusy = state.busy,
                            exportBusy = state.exportBusy,
                            onIncludeBehaviorHistoryChange = viewModel::setIncludeBehaviorHistory,
                            onExport = viewModel::requestExport,
                            onRefresh = viewModel::refreshExport,
                            onDownload = {
                                createExportDocument.launch("chi-shen-me-account-export.json")
                            },
                        )
                    }
                    item {
                        AccountActionsCard(
                            accountDeletionAvailable = accountDeletionAvailable(remoteFeatureConfig),
                            busy = state.busy || state.exportBusy,
                            onLogout = viewModel::logout,
                            onDelete = { confirmDelete = true },
                        )
                    }
                }
            }
        }
    }

    pendingUnbind?.let { binding ->
        ConfirmDialog(
            title = "解绑${binding.type.displayName()}？",
            text = "解绑后不能再用 ${binding.maskedValue} 登录。不会自动合并或转移到其他账号。",
            confirm = "确认解绑",
            onConfirm = {
                pendingUnbind = null
                if (accountSecurityMutationAvailable(capabilities)) {
                    viewModel.unbind(binding.bindingId)
                }
            },
            onDismiss = { pendingUnbind = null },
        )
    }
    pendingRevoke?.let { session ->
        ConfirmDialog(
            title = "退出这台设备？",
            text = "${session.deviceLabel} 的登录会话将立即失效。",
            confirm = "退出设备",
            onConfirm = {
                pendingRevoke = null
                if (accountSecurityMutationAvailable(capabilities)) {
                    viewModel.revokeSession(session.sessionId)
                }
            },
            onDismiss = { pendingRevoke = null },
        )
    }
    if (confirmDelete) {
        ConfirmDialog(
            title = "注销账号？",
            text = "注销后令牌立即失效，个人信息按隐私政策清理，滚动备份中的可恢复信息最迟 30 天清除。此操作不能在 App 内撤销。",
            confirm = "确认注销",
            destructive = true,
            onConfirm = {
                confirmDelete = false
                if (accountDeletionAvailable(remoteFeatureConfig)) {
                    viewModel.deleteAccount()
                }
            },
            onDismiss = { confirmDelete = false },
        )
    }
}

@Composable
private fun AccountServiceGateCard(remoteFeatureConfig: RemoteFeatureConfigState) {
    val (title, body, tone) = when (remoteFeatureConfig) {
        is RemoteFeatureConfigState.Loading -> Triple(
            "正在连接账号服务",
            "正在核对远端能力与本机安全状态；游客推荐不会因此受阻。",
            AppTone.INFO,
        )
        is RemoteFeatureConfigState.Unavailable -> Triple(
            "暂时无法核对账号服务",
            "当前没有取得可信的远端能力配置。账号入口已安全暂停，游客推荐仍可使用。",
            AppTone.WARNING,
        )
        is RemoteFeatureConfigState.Incompatible -> Triple(
            "当前版本暂不能使用账号服务",
            "服务端要求更高版本的安全能力。更新前不会尝试登录、绑定或修改账号。",
            AppTone.WARNING,
        )
        is RemoteFeatureConfigState.Ready -> Triple(
            "账号能力当前未开放",
            "游客仍可使用全部核心推荐。账号服务通过部署与安全门禁后才会开放。",
            AppTone.NEUTRAL,
        )
    }
    AppCard {
        AppSectionHeader(
            title = title,
            subtitle = "账号通道按远端可信配置失败关闭",
            trailing = { AppIconTile(Icons.Rounded.Lock, tone = tone) },
        )
        AppStatusBanner(
            title = if (remoteFeatureConfig is RemoteFeatureConfigState.Loading) {
                "正在安全检查…"
            } else {
                "核心推荐不受影响"
            },
            body = body,
            tone = tone,
            icon = if (remoteFeatureConfig is RemoteFeatureConfigState.Loading) null else Icons.Rounded.Info,
            action = if (remoteFeatureConfig is RemoteFeatureConfigState.Loading) {
                {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.5.dp,
                    )
                }
            } else {
                null
            },
        )
    }
}

@Composable
private fun AccountSessionCheckingCard() {
    AppCard {
        AppSectionHeader(
            title = "正在恢复安全会话",
            subtitle = "只读取 Android Keystore 保护的本机登录材料。",
            trailing = { AppIconTile(Icons.Rounded.Lock, tone = AppTone.INFO) },
        )
        AppStatusBanner(
            title = "正在检查本机登录状态…",
            body = "核对完成前不会发起身份绑定或账号写入操作。",
            tone = AppTone.INFO,
            icon = Icons.Rounded.Lock,
            action = {
                CircularProgressIndicator(
                    modifier = Modifier.size(24.dp),
                    strokeWidth = 2.5.dp,
                )
            },
        )
    }
}

@Composable
private fun SignedInServiceUnavailableCard(remoteFeatureConfig: RemoteFeatureConfigState) {
    val detail = when (remoteFeatureConfig) {
        is RemoteFeatureConfigState.Loading -> "正在重新核对远端账号能力，本机会话仍受保护。"
        is RemoteFeatureConfigState.Unavailable -> "暂时无法取得可信配置，远端安全操作已暂停。"
        is RemoteFeatureConfigState.Incompatible -> "当前版本与远端安全要求不兼容，远端操作已暂停。"
        is RemoteFeatureConfigState.Ready -> "账号能力已由服务端关闭，远端安全操作已暂停。"
    }
    AppStatusBanner(
        title = "本机会话仍受保护",
        body = detail,
        tone = if (remoteFeatureConfig is RemoteFeatureConfigState.Loading) AppTone.INFO else AppTone.WARNING,
        icon = Icons.Rounded.Lock,
        action = if (remoteFeatureConfig is RemoteFeatureConfigState.Loading) {
            {
                CircularProgressIndicator(
                    modifier = Modifier.size(22.dp),
                    strokeWidth = 2.5.dp,
                )
            }
        } else {
            null
        },
    )
}

@Composable
private fun AccountBusyBanner(state: AccountUiState) {
    val (title, body) = when (state.authStep) {
        AccountAuthStep.OTP_LOGIN,
        AccountAuthStep.PHONE_REGISTER,
        -> "正在安全验证" to "正在处理验证码请求或登录验证，请勿重复提交。"
        AccountAuthStep.WECHAT_LOGIN -> "正在等待微信验证" to "完成微信授权后会自动返回，不会读取无关资料。"
        AccountAuthStep.QQ_LOGIN -> "正在等待 QQ 验证" to "完成 QQ 授权后会自动返回，不会接收 access token 或 OpenID。"
        AccountAuthStep.BIND_EMAIL -> "正在绑定邮箱" to "仅会把验证成功的邮箱绑定到当前手机号账号。"
        AccountAuthStep.BIND_WECHAT -> "正在绑定微信" to "验证完成前不会修改当前登录身份。"
        AccountAuthStep.BIND_QQ -> "正在绑定 QQ" to "验证完成前不会修改当前登录身份。"
        AccountAuthStep.CHOOSE -> if (state.status == AccountStatus.SIGNED_IN) {
            "正在更新账号安全状态" to "身份、设备或会话操作正在安全处理，请稍候。"
        } else {
            "正在处理账号状态" to "正在安全完成本机会话操作，请稍候。"
        }
    }
    AppStatusBanner(
        title = title,
        body = body,
        tone = AppTone.INFO,
        icon = Icons.Rounded.Lock,
        action = {
            CircularProgressIndicator(
                modifier = Modifier.size(22.dp),
                strokeWidth = 2.5.dp,
            )
        },
    )
}


@Composable
private fun ExternalAuthMethodHeader(
    title: String,
    description: String,
    available: Boolean,
    pendingLabel: String = "可用",
    constraintLabel: String = "仅已绑定身份",
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        AppIconTile(
            icon = Icons.Rounded.Lock,
            tone = if (available) AppTone.ACCENT else AppTone.NEUTRAL,
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                AppBadge(
                    text = if (available) pendingLabel else "受保护",
                    tone = if (available) AppTone.SUCCESS else AppTone.NEUTRAL,
                )
                AppBadge(text = constraintLabel, tone = AppTone.INFO)
            }
        }
    }
}

@Composable
private fun WechatAvailabilityContent(
    serverEnabled: Boolean,
    clientConfigured: Boolean,
    actionLabel: String,
    busy: Boolean,
    onAction: () -> Unit,
) {
    when {
        !serverEnabled -> AppStatusBanner(
            title = "微信登录暂未开放",
            body = "当前服务端尚未开放微信登录。",
            tone = AppTone.WARNING,
            icon = Icons.Rounded.Info,
        )
        !clientConfigured -> AppStatusBanner(
            title = "当前安装包未启用微信",
            body = "此安装包未配置微信开放平台 AppID，微信能力已安全关闭。",
            tone = AppTone.NEUTRAL,
            icon = Icons.Rounded.Lock,
        )
        else -> OutlinedButton(
            onClick = onAction,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = AppDimens.MinTouchTarget),
            shape = MaterialTheme.shapes.medium,
        ) {
            Icon(Icons.Rounded.Lock, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(7.dp))
            Text(actionLabel, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun QqAvailabilityContent(
    serverEnabled: Boolean,
    clientConfigured: Boolean,
    hostAvailable: Boolean,
    actionLabel: String,
    busy: Boolean,
    onAction: () -> Unit,
) {
    when {
        !serverEnabled -> AppStatusBanner(
            title = "QQ 登录与绑定暂未开放",
            body = "当前服务端尚未开放 QQ 登录与绑定，游客推荐不受影响。",
            tone = AppTone.WARNING,
            icon = Icons.Rounded.Info,
        )
        !clientConfigured -> AppStatusBanner(
            title = "当前安装包未启用 QQ",
            body = "此安装包未配置腾讯 QQ 互联 AppID，QQ 能力已安全关闭。",
            tone = AppTone.NEUTRAL,
            icon = Icons.Rounded.Lock,
        )
        !hostAvailable -> AppStatusBanner(
            title = "暂时无法调起 QQ",
            body = "当前页面环境无法安全调起 QQ，请重新打开账号页。",
            tone = AppTone.WARNING,
            icon = Icons.Rounded.Info,
        )
        else -> OutlinedButton(
            onClick = onAction,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = AppDimens.MinTouchTarget),
            shape = MaterialTheme.shapes.medium,
        ) {
            Icon(Icons.Rounded.Lock, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(7.dp))
            Text(actionLabel, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun SignedInCard(
    identities: Int,
    sessions: Int,
    onRefresh: () -> Unit,
    busy: Boolean,
) {
    AppHeroCard(
        eyebrow = "账号受保护",
        title = "已安全登录",
        description = "访问令牌只保存在内存，刷新令牌由 Android Keystore 加密。",
        icon = Icons.Rounded.Lock,
        footer = {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AppBadge(text = "会话有效", tone = AppTone.SUCCESS)
                AppBadge(text = "$identities 个身份", tone = AppTone.INFO)
                AppBadge(text = "$sessions 台设备", tone = AppTone.INFO)
                TextButton(
                    onClick = onRefresh,
                    enabled = !busy,
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = Color.White,
                        disabledContentColor = Color.White.copy(alpha = 0.45f),
                    ),
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(5.dp))
                    Text("刷新")
                }
            }
        }
    )
}

@Composable
private fun SecurityOverviewCard(
    identities: Int,
    sessions: Int,
    loading: Boolean,
) {
    AppCard {
        AppSectionHeader(
            title = "安全概览",
            subtitle = "先看当前账号的关键保护状态，再进入具体管理。",
            trailing = {
                AppBadge(
                    text = if (loading) "核对中" else "已保护",
                    tone = if (loading) AppTone.INFO else AppTone.SUCCESS,
                )
            },
        )
        if (loading) {
            AppStatusBanner(
                title = "正在读取账号安全信息",
                body = "身份与设备返回前不会显示未经确认的绑定入口。",
                tone = AppTone.INFO,
                icon = Icons.Rounded.Lock,
                action = {
                    CircularProgressIndicator(
                        modifier = Modifier.size(22.dp),
                        strokeWidth = 2.5.dp,
                    )
                },
            )
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SecurityMetricTile("$identities 项", "已验证身份", AppTone.ACCENT, Modifier.weight(1f))
                SecurityMetricTile("$sessions 台", "登录设备", AppTone.INFO, Modifier.weight(1f))
                SecurityMetricTile("已开启", "本机加密", AppTone.SUCCESS, Modifier.weight(1f))
            }
        }
        AppStatusBanner(
            title = "推荐排序与账号身份分离",
            body = "登录只用于同步、设备管理和数据权利，不会提高或降低餐厅推荐排名。",
            tone = AppTone.NEUTRAL,
            icon = Icons.Rounded.Info,
        )
    }
}

@Composable
private fun SecurityMetricTile(
    value: String,
    label: String,
    tone: AppTone,
    modifier: Modifier = Modifier,
) {
    val color = when (tone) {
        AppTone.ACCENT -> MaterialTheme.colorScheme.primary
        AppTone.SUCCESS -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.secondary
    }
    Surface(
        modifier = modifier,
        color = color.copy(alpha = 0.09f),
        contentColor = MaterialTheme.colorScheme.onSurface,
        shape = RoundedCornerShape(AppDimens.CompactRadius),
        border = BorderStroke(1.dp, color.copy(alpha = 0.16f)),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(value, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun IdentityCard(
    identities: List<AuthIdentityBinding>,
    loading: Boolean,
    busy: Boolean,
    onUnbind: (AuthIdentityBinding) -> Unit,
) {
    AppCard {
        AppSectionHeader(
            title = "登录身份",
            subtitle = "只展示已经过验证的脱敏身份。",
            trailing = {
                AppBadge(
                    text = "${identities.size} 个身份",
                    tone = if (identities.isEmpty()) AppTone.NEUTRAL else AppTone.SUCCESS,
                )
            },
        )
        if (identities.isEmpty()) {
            AppStatusBanner(
                title = if (loading) "正在读取登录身份" else "身份信息尚未就绪",
                body = if (loading) {
                    "读取完成前不会显示可能错误的绑定入口。"
                } else {
                    "暂未取得已验证身份，请稍后刷新；当前不会允许解绑或新增绑定。"
                },
                tone = if (loading) AppTone.INFO else AppTone.WARNING,
                icon = if (loading) Icons.Rounded.Lock else Icons.Rounded.Info,
                action = if (loading) {
                    {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.5.dp,
                        )
                    }
                } else {
                    null
                },
            )
        }
        identities.forEachIndexed { index, identity ->
            if (index > 0) HorizontalDivider()
            Column(
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    AppIconTile(
                        icon = Icons.Rounded.Lock,
                        tone = if (identity.primary) AppTone.ACCENT else AppTone.INFO,
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            "${identity.type.displayName()} · ${identity.maskedValue}",
                            fontWeight = FontWeight.SemiBold,
                        )
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            AppBadge(
                                text = if (identity.primary) "主身份" else "已验证",
                                tone = if (identity.primary) AppTone.ACCENT else AppTone.SUCCESS,
                            )
                            if (identity.primary) {
                                AppBadge(text = "不可解绑", tone = AppTone.NEUTRAL)
                            }
                        }
                    }
                }
                if (identity.canUnbind) {
                    TextButton(
                        onClick = { onUnbind(identity) },
                        enabled = !busy,
                        modifier = Modifier
                            .align(Alignment.End)
                            .semantics {
                                contentDescription = "解绑${identity.type.displayName()} ${identity.maskedValue}"
                            },
                    ) { Text("解绑") }
                }
            }
        }
    }
}

@Composable
private fun AddLoginMethodsCard(
    dataReady: Boolean,
    state: AccountUiState,
    capabilities: AuthCapabilities,
    hostAvailable: Boolean,
    onRequestEmailCode: (String) -> Unit,
    onSubmitEmailCode: (String) -> Unit,
    onResend: () -> Unit,
    onReset: () -> Unit,
    onEmailChange: (String) -> Unit,
    onOtpChange: (String) -> Unit,
    onWechatBind: () -> Unit,
    onQqBind: () -> Unit,
) {
    val showEmail = dataReady && capabilities.emailEnabled &&
        state.identities.none { it.type == AuthIdentityType.EMAIL }
    val showWechat = dataReady && capabilities.wechatEnabled &&
        state.identities.none { it.type == AuthIdentityType.WECHAT }
    val showQq = dataReady && state.identities.none { it.type == AuthIdentityType.QQ }
    val methodCount = listOf(showEmail, showWechat, showQq).count { it }

    AppCard {
        AppSectionHeader(
            title = "添加登录方式",
            subtitle = "绑定只发生在当前手机号账号内；冲突时会拒绝，不会静默合并。",
            trailing = {
                AppBadge(
                    text = if (!dataReady) "等待身份" else "$methodCount 项可添加",
                    tone = if (!dataReady) AppTone.NEUTRAL else AppTone.INFO,
                )
            },
        )
        when {
            !dataReady -> AppStatusBanner(
                title = "正在确认已有登录身份",
                body = "只有身份列表可靠返回后，才会展示确实缺少的绑定入口。",
                tone = AppTone.INFO,
                icon = Icons.Rounded.Lock,
            )
            methodCount == 0 -> AppStatusBanner(
                title = "可用登录方式均已绑定",
                body = "当前账号已有完整的可用身份组合。",
                tone = AppTone.SUCCESS,
                icon = Icons.Rounded.Check,
            )
            else -> {
                if (showEmail) {
                    BindEmailContent(
                        state = state,
                        onRequestCode = onRequestEmailCode,
                        onSubmit = onSubmitEmailCode,
                        onResend = onResend,
                        onReset = onReset,
                        onEmailChange = onEmailChange,
                        onOtpChange = onOtpChange,
                    )
                }
                if (showEmail && (showWechat || showQq)) HorizontalDivider()
                if (showWechat) {
                    ExternalAuthMethodHeader(
                        title = "绑定微信",
                        description = "绑定后可用微信登录当前账号；若已属于其他账号，系统会拒绝。",
                        available = state.wechatClientConfigured,
                        pendingLabel = "待绑定",
                        constraintLabel = "绑定到当前账号",
                    )
                    WechatAvailabilityContent(
                        serverEnabled = capabilities.wechatEnabled,
                        clientConfigured = state.wechatClientConfigured,
                        actionLabel = "前往微信验证绑定",
                        busy = state.busy,
                        onAction = onWechatBind,
                    )
                }
                if (showWechat && showQq) HorizontalDivider()
                if (showQq) {
                    ExternalAuthMethodHeader(
                        title = "绑定 QQ",
                        description = "绑定后可用 QQ 登录；若已属于其他账号，系统会拒绝。",
                        available = capabilities.qqEnabled && state.qqClientConfigured && hostAvailable,
                        pendingLabel = "待绑定",
                        constraintLabel = "绑定到当前账号",
                    )
                    QqAvailabilityContent(
                        serverEnabled = capabilities.qqEnabled,
                        clientConfigured = state.qqClientConfigured,
                        hostAvailable = hostAvailable,
                        actionLabel = "前往 QQ 验证绑定",
                        busy = state.busy,
                        onAction = onQqBind,
                    )
                }
            }
        }
    }
}

@Composable
private fun BindEmailContent(
    state: AccountUiState,
    onRequestCode: (String) -> Unit,
    onSubmit: (String) -> Unit,
    onResend: () -> Unit,
    onReset: () -> Unit,
    onEmailChange: (String) -> Unit,
    onOtpChange: (String) -> Unit,
) {
    val email = state.otpTargetDraft.takeIf {
        state.otpInputType == AuthIdentityType.EMAIL
    }.orEmpty()
    val otp = state.otpCodeDraft
    val challenge = state.challenge?.takeIf {
        it.purpose == OtpPurpose.BIND && it.type == AuthIdentityType.EMAIL
    }
    val emailHasError = email.isNotBlank() && !email.matches(ACCOUNT_EMAIL_INPUT)
    ExternalAuthMethodHeader(
        title = "绑定邮箱",
        description = "邮箱只能在现有账号内验证绑定，不能单独创建新账号。",
        available = true,
        pendingLabel = if (challenge == null) "待绑定" else "验证中",
        constraintLabel = "绑定到当前账号",
    )
    if (challenge == null) {
        OutlinedTextField(
            value = email,
            onValueChange = onEmailChange,
            label = { Text("邮箱") },
            supportingText = {
                Text(if (emailHasError) "请输入完整有效的邮箱地址" else "验证码只用于本次绑定")
            },
            isError = emailHasError,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            singleLine = true,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        )
        AppPrimaryButton(
            text = "发送绑定验证码",
            onClick = { onRequestCode(email) },
            enabled = email.matches(ACCOUNT_EMAIL_INPUT) && !state.busy,
            icon = Icons.Rounded.Lock,
        )
    } else {
        AppStatusBanner(
            title = "验证码已发送至 ${challenge.maskedTarget}",
            body = "请在有效期内完成邮箱绑定。",
            tone = AppTone.SUCCESS,
            icon = Icons.Rounded.Lock,
        )
        OtpChallengeTiming(
            state = state,
            challenge = challenge,
            onResend = onResend,
            onResetForNewTarget = onReset,
        )
        OutlinedTextField(
            value = otp,
            onValueChange = onOtpChange,
            label = { Text("6 位验证码") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            singleLine = true,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        )
        AppPrimaryButton(
            text = "确认绑定",
            onClick = { onSubmit(otp) },
            enabled = otp.length == 6 && !state.busy,
            icon = Icons.Rounded.Lock,
        )
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onReset, enabled = !state.busy) { Text("取消") }
        }
    }
}

@Composable
private fun OtpChallengeTiming(
    state: AccountUiState,
    challenge: PendingOtpChallenge,
    onResend: () -> Unit,
    onResetForNewTarget: () -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        AppBadge(
            text = "有效期 ${state.otpSecondsUntilExpiry} 秒",
            tone = if (state.otpSecondsUntilExpiry > 0) AppTone.INFO else AppTone.WARNING,
        )
        if (state.otpCanResend && state.otpSecondsUntilResend > 0L) {
            AppBadge(text = "${state.otpSecondsUntilResend} 秒后可重发", tone = AppTone.NEUTRAL)
        }
    }
    if (state.otpCanResend) {
        TextButton(
            onClick = onResend,
            enabled = state.otpSecondsUntilResend == 0L && !state.busy,
        ) {
            Text(
                if (state.otpSecondsUntilResend > 0L) {
                    "等待重新发送"
                } else {
                    "重新发送验证码"
                },
            )
        }
    } else {
        TextButton(onClick = onResetForNewTarget, enabled = !state.busy) {
            Text(
                if (challenge.type == AuthIdentityType.EMAIL) {
                    "重新输入邮箱获取新验证码"
                } else {
                    "重新输入手机号获取新验证码"
                },
            )
        }
    }
}

@Composable
private fun SessionsCard(
    sessions: List<AuthSessionSummary>,
    loading: Boolean,
    busy: Boolean,
    onRevoke: (AuthSessionSummary) -> Unit,
) {
    AppCard {
        AppSectionHeader(
            title = "登录设备",
            subtitle = "查看并管理仍然有效的设备会话。",
            trailing = {
                AppBadge(
                    text = "${sessions.size} 台设备",
                    tone = if (sessions.isEmpty()) AppTone.NEUTRAL else AppTone.INFO,
                )
            },
        )
        if (sessions.isEmpty()) {
            AppStatusBanner(
                title = if (loading) "正在读取登录设备" else "设备信息尚未就绪",
                body = if (loading) {
                    "完成核对前不会显示可能错误的设备状态。"
                } else {
                    "暂未取得登录设备，请稍后刷新；不会据此退出任何会话。"
                },
                tone = if (loading) AppTone.INFO else AppTone.WARNING,
                icon = if (loading) Icons.Rounded.Lock else Icons.Rounded.Info,
                action = if (loading) {
                    {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.5.dp,
                        )
                    }
                } else {
                    null
                },
            )
        }
        sessions.forEachIndexed { index, session ->
            if (index > 0) HorizontalDivider()
            Column(
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    AppIconTile(
                        icon = Icons.Rounded.Lock,
                        tone = if (session.current) AppTone.SUCCESS else AppTone.NEUTRAL,
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(session.deviceLabel, fontWeight = FontWeight.SemiBold)
                        Text(
                            "${session.platform} · 最近 ${formatInstant(session.lastActiveAt)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        AppBadge(
                            text = if (session.current) "当前设备" else "其他设备",
                            tone = if (session.current) AppTone.SUCCESS else AppTone.NEUTRAL,
                        )
                    }
                }
                if (!session.current) {
                    TextButton(
                        onClick = { onRevoke(session) },
                        enabled = !busy,
                        modifier = Modifier
                            .align(Alignment.End)
                            .semantics {
                                contentDescription = "退出设备 ${session.deviceLabel}"
                            },
                    ) { Text("退出") }
                }
            }
        }
    }
}

@Composable
private fun DataRightsCard(
    export: AccountExportStatusResponse?,
    dataExportEnabled: Boolean,
    includeBehaviorHistory: Boolean,
    controlsBusy: Boolean,
    exportBusy: Boolean,
    onIncludeBehaviorHistoryChange: (Boolean) -> Unit,
    onExport: () -> Unit,
    onRefresh: () -> Unit,
    onDownload: () -> Unit,
) {
    val actionsBusy = controlsBusy || exportBusy
    AppCard {
        AppSectionHeader(
            title = "账号数据导出",
            subtitle = "导出由你主动发起，范围、状态和完整性清晰可见。",
            trailing = {
                AppBadge(
                    text = if (dataExportEnabled) "导出可用" else "导出关闭",
                    tone = if (dataExportEnabled) AppTone.SUCCESS else AppTone.NEUTRAL,
                )
            },
        )
        if (dataExportEnabled) {
            AppStatusBanner(
                title = "可申请 JSON 数据导出；文件最长保留 7 天，大小上限为 10 MiB。",
                body = "导出不包含登录令牌、第三方原始标识、精确位置或内部安全字段。",
                tone = AppTone.INFO,
                icon = Icons.Rounded.Lock,
            )
            FilterChip(
                selected = includeBehaviorHistory,
                onClick = { onIncludeBehaviorHistoryChange(!includeBehaviorHistory) },
                enabled = !actionsBusy,
                leadingIcon = if (includeBehaviorHistory) {
                    {
                        Icon(
                            Icons.Rounded.Check,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                } else {
                    null
                },
                label = { Text("包含近 90 天推荐行为记录") },
            )
            when (export) {
                null -> AppStatusBanner(
                    title = "当前没有数据导出任务",
                    body = "你可以按当前选择的范围发起一次新的导出。",
                    tone = AppTone.NEUTRAL,
                    icon = Icons.Rounded.Info,
                )
                else -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            "最近导出：${export.status.displayName()}",
                            modifier = Modifier.weight(1f),
                            fontWeight = FontWeight.SemiBold,
                        )
                        AppBadge(
                            text = export.status.displayName(),
                            tone = export.status.appTone(),
                        )
                    }
                    Text(
                        "范围：${if (export.includeBehaviorHistory) "包含推荐行为记录" else "不包含推荐行为记录"}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        "申请时间：${formatInstant(export.requestedAt)}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        "失效时间：${formatInstant(export.expiresAt)}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    when (export.status) {
                        AccountExportStatus.QUEUED -> AppStatusBanner(
                            title = "任务正在排队，可稍后刷新。",
                            body = "排队期间无需停留在当前页面。",
                            tone = AppTone.INFO,
                            icon = Icons.Rounded.Info,
                        )
                        AccountExportStatus.PROCESSING -> AppStatusBanner(
                            title = "正在生成文件，可稍后刷新。",
                            body = "导出完成前不会创建本地文件。",
                            tone = AppTone.INFO,
                            icon = Icons.Rounded.Lock,
                        )
                        AccountExportStatus.READY -> {
                            Text(
                                "文件大小：${formatFileSize(requireNotNull(export.sizeBytes))}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "SHA-256：${checksumSummary(requireNotNull(export.sha256))}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "请选择可信的本机或云端文件位置；所选文件服务可能处理导出内容。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            AppPrimaryButton(
                                text = "选择保存位置并下载",
                                onClick = onDownload,
                                enabled = !actionsBusy && export.downloadAvailable,
                                icon = Icons.Rounded.Lock,
                            )
                        }
                        AccountExportStatus.FAILED -> AppStatusBanner(
                            title = "文件生成失败，可重新申请。",
                            body = "当前失败不会影响其他账号数据权利。",
                            tone = AppTone.ERROR,
                            icon = Icons.Rounded.Info,
                        )
                        AccountExportStatus.EXPIRED -> AppStatusBanner(
                            title = "文件已过期，请重新申请。",
                            body = "过期文件不能继续下载。",
                            tone = AppTone.WARNING,
                            icon = Icons.Rounded.Info,
                        )
                    }
                }
            }
            if (exportBusy) {
                AppStatusBanner(
                    title = "正在安全处理数据导出…",
                    body = "请保留当前页面，处理完成后会显示结果。",
                    tone = AppTone.INFO,
                    icon = Icons.Rounded.Lock,
                    action = {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.5.dp,
                        )
                    },
                )
            }
            OutlinedButton(
                onClick = onRefresh,
                enabled = !actionsBusy,
                modifier = Modifier.fillMaxWidth().heightIn(min = AppDimens.MinTouchTarget),
                shape = MaterialTheme.shapes.medium,
            ) {
                Text("刷新导出状态")
            }
            AppPrimaryButton(
                text = if (export == null) "申请数据导出" else "重新申请数据导出",
                onClick = onExport,
                enabled = !actionsBusy && export?.status !in setOf(
                    AccountExportStatus.QUEUED,
                    AccountExportStatus.PROCESSING,
                ),
            )
        } else {
            AppStatusBanner(
                title = "数据导出当前未开放",
                body = "服务端尚未开放安全的数据导出通道；其他账号权利不受影响。",
                tone = AppTone.NEUTRAL,
                icon = Icons.Rounded.Info,
            )
        }
    }
}

@Composable
private fun AccountActionsCard(
    accountDeletionAvailable: Boolean,
    busy: Boolean,
    onLogout: () -> Unit,
    onDelete: () -> Unit,
) {
    AppCard {
        AppSectionHeader(
            title = "会话与危险操作",
            subtitle = "退出只清理当前登录；注销会进入不可撤销的数据清理流程。",
            trailing = { AppBadge(text = "谨慎操作", tone = AppTone.ERROR) },
        )
        OutlinedButton(
            onClick = onLogout,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = AppDimens.PrimaryButtonHeight),
            shape = MaterialTheme.shapes.medium,
        ) {
            Icon(Icons.Rounded.Lock, contentDescription = null, modifier = Modifier.size(19.dp))
            Spacer(Modifier.width(8.dp))
            Text("退出当前账号", fontWeight = FontWeight.SemiBold)
        }
        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.34f),
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
            shape = RoundedCornerShape(AppDimens.CompactRadius),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.22f)),
        ) {
            Column(
                modifier = Modifier.padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AppIconTile(Icons.Rounded.Delete, tone = AppTone.ERROR, size = 38.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("注销账号", fontWeight = FontWeight.Bold)
                        Text(
                            "令牌会立即失效，个人信息随后按隐私政策清理。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                    }
                }
                if (!accountDeletionAvailable) {
                    AppStatusBanner(
                        title = "注销请求当前不可用",
                        body = "账号服务已明确关闭，暂时无法安全鉴权；请勿卸载 App，并联系运营方处理数据权利请求。",
                        tone = AppTone.ERROR,
                        icon = Icons.Rounded.Info,
                    )
                }
                OutlinedButton(
                    onClick = onDelete,
                    enabled = !busy && accountDeletionAvailable,
                    modifier = Modifier.fillMaxWidth().heightIn(min = AppDimens.MinTouchTarget),
                    shape = MaterialTheme.shapes.medium,
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                        disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    ),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.42f)),
                ) {
                    Icon(Icons.Rounded.Delete, contentDescription = null, modifier = Modifier.size(19.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("注销账号", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

internal fun showAccountExportControls(
    serverDataExportEnabled: Boolean,
    viewModelDataExportEnabled: Boolean,
): Boolean = serverDataExportEnabled && viewModelDataExportEnabled

internal fun accountSecurityMutationAvailable(capabilities: AuthCapabilities?): Boolean =
    capabilities?.accountsEnabled == true

internal fun accountDeletionAvailable(remoteFeatureConfig: RemoteFeatureConfigState): Boolean =
    when (remoteFeatureConfig) {
        is RemoteFeatureConfigState.Loading -> true
        is RemoteFeatureConfigState.Ready ->
            remoteFeatureConfig.config.authCapabilities?.accountsEnabled == true
        is RemoteFeatureConfigState.Unavailable,
        is RemoteFeatureConfigState.Incompatible,
        -> false
    }

private fun AccountExportStatus.displayName(): String = when (this) {
    AccountExportStatus.QUEUED -> "排队中"
    AccountExportStatus.PROCESSING -> "生成中"
    AccountExportStatus.READY -> "可下载"
    AccountExportStatus.FAILED -> "生成失败"
    AccountExportStatus.EXPIRED -> "已过期"
}

private fun AccountExportStatus.appTone(): AppTone = when (this) {
    AccountExportStatus.QUEUED,
    AccountExportStatus.PROCESSING,
    -> AppTone.INFO
    AccountExportStatus.READY -> AppTone.SUCCESS
    AccountExportStatus.FAILED -> AppTone.ERROR
    AccountExportStatus.EXPIRED -> AppTone.WARNING
}

internal fun formatFileSize(bytes: Long): String = when {
    bytes < 1_024 -> "$bytes B"
    bytes < 1_048_576 -> String.format(Locale.ROOT, "%.1f KB", bytes / 1_024.0)
    else -> String.format(Locale.ROOT, "%.1f MB", bytes / 1_048_576.0)
}

internal fun checksumSummary(checksum: String): String =
    if (checksum.length == 64) "${checksum.take(12)}…${checksum.takeLast(8)}" else "校验值不可用"

@Composable
private fun ConfirmDialog(
    title: String,
    text: String,
    confirm: String,
    destructive: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AppDialog(
        onDismissRequest = onDismiss,
        icon = {
            AppIconTile(
                icon = if (destructive) Icons.Rounded.Delete else Icons.Rounded.Lock,
                tone = if (destructive) AppTone.ERROR else AppTone.ACCENT,
                size = 48.dp,
            )
        },
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirm, color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

private fun AuthIdentityType.displayName(): String = when (this) {
    AuthIdentityType.PHONE -> "手机号"
    AuthIdentityType.WECHAT -> "微信"
    AuthIdentityType.EMAIL -> "邮箱"
    AuthIdentityType.QQ -> "QQ"
}

private fun formatInstant(raw: String): String = runCatching {
    ACCOUNT_TIME_FORMATTER.format(Instant.parse(raw))
}.getOrDefault("未知时间")

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private val LOCAL_MAINLAND_PHONE_INPUT = Regex("^1[3-9]\\d{9}$")
private val INTERNATIONAL_MAINLAND_PHONE_INPUT = Regex("^\\+861[3-9]\\d{9}$")
private val ACCOUNT_EMAIL_INPUT = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
private val ACCOUNT_TIME_FORMATTER = DateTimeFormatter
    .ofPattern("MM-dd HH:mm")
    .withZone(ZoneId.systemDefault())
