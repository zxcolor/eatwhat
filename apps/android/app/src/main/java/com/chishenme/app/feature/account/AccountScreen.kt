package com.chishenme.app.feature.account

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

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
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(state.message) {
        state.message?.let {
            snackbar.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("账号与安全") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when {
                capabilities?.accountsEnabled != true && state.status != AccountStatus.SIGNED_IN -> item {
                    CapabilityUnavailableCard()
                }
                state.status == AccountStatus.CHECKING -> item {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator()
                        Spacer(Modifier.width(12.dp))
                        Text("正在检查本机登录状态…")
                    }
                }
                state.status == AccountStatus.GUEST -> {
                    val guestCapabilities = requireNotNull(capabilities)
                    item { GuestNoticeCard() }
                    item {
                        OtpLoginCard(
                            state = state,
                            capabilities = guestCapabilities,
                            onRequestCode = { type, target ->
                                viewModel.requestCode(type, OtpPurpose.LOGIN, target)
                            },
                            onSubmit = viewModel::submitLoginCode,
                            onReset = viewModel::clearChallenge,
                        )
                    }
                    item {
                        WechatLoginCard(
                            serverEnabled = guestCapabilities.wechatEnabled,
                            clientConfigured = state.wechatClientConfigured,
                            busy = state.busy,
                            onLogin = viewModel::startWechatLogin,
                        )
                    }
                    item {
                        PhoneWechatRegistrationCard(
                            state = state,
                            capabilities = guestCapabilities,
                            onRequestCode = { phone ->
                                viewModel.requestCode(
                                    AuthIdentityType.PHONE,
                                    OtpPurpose.REGISTER,
                                    phone,
                                )
                            },
                            onAuthorizeAndRegister = viewModel::submitPhoneWechatRegistration,
                            onReset = viewModel::clearChallenge,
                        )
                    }
                    item {
                        QqLoginCard(
                            serverEnabled = guestCapabilities.qqEnabled,
                            clientConfigured = state.qqClientConfigured,
                            hostAvailable = hostActivity != null,
                            busy = state.busy,
                            onLogin = { hostActivity?.let(viewModel::startQqLogin) },
                        )
                    }
                }
                else -> {
                    val activeCapabilities = capabilities?.takeIf { it.accountsEnabled }
                    if (activeCapabilities != null) {
                        item { SignedInCard(onRefresh = viewModel::refreshSecurityData, busy = state.busy) }
                        item {
                            IdentityCard(
                                identities = state.identities,
                                onUnbind = { pendingUnbind = it },
                            )
                        }
                        if (
                            activeCapabilities.emailEnabled &&
                            state.identities.none { it.type == AuthIdentityType.EMAIL }
                        ) {
                            item {
                                BindEmailCard(
                                    state = state,
                                    onRequestCode = { email ->
                                        viewModel.requestCode(AuthIdentityType.EMAIL, OtpPurpose.BIND, email)
                                    },
                                    onSubmit = viewModel::submitBindCode,
                                    onReset = viewModel::clearChallenge,
                                )
                            }
                        }
                        if (state.identities.none { it.type == AuthIdentityType.QQ }) {
                            item {
                                BindQqCard(
                                    serverEnabled = activeCapabilities.qqEnabled,
                                    clientConfigured = state.qqClientConfigured,
                                    hostAvailable = hostActivity != null,
                                    busy = state.busy,
                                    onBind = { hostActivity?.let(viewModel::startQqBind) },
                                )
                            }
                        }
                        item {
                            SessionsCard(
                                sessions = state.sessions,
                                onRevoke = { pendingRevoke = it },
                            )
                        }
                    } else {
                        item { CapabilityUnavailableCard() }
                    }
                    item {
                        DataRightsCard(
                            export = state.export,
                            dataExportEnabled = showAccountExportControls(
                                serverDataExportEnabled = activeCapabilities?.dataExportEnabled == true,
                                viewModelDataExportEnabled = state.dataExportEnabled,
                            ),
                            accountDeletionAvailable = accountDeletionAvailable(remoteFeatureConfig),
                            includeBehaviorHistory = state.includeBehaviorHistory,
                            busy = state.busy || state.exportBusy,
                            onIncludeBehaviorHistoryChange = viewModel::setIncludeBehaviorHistory,
                            onExport = viewModel::requestExport,
                            onRefresh = viewModel::refreshExport,
                            onDownload = {
                                createExportDocument.launch("chi-shen-me-account-export.json")
                            },
                            onDelete = { confirmDelete = true },
                        )
                    }
                    item {
                        OutlinedButton(
                            onClick = viewModel::logout,
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("退出当前账号") }
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
private fun CapabilityUnavailableCard() {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Rounded.Info, null, tint = MaterialTheme.colorScheme.primary)
            Text("账号能力当前未开放", style = MaterialTheme.typography.titleLarge)
            Text("游客仍可使用全部核心推荐。账号服务只有在数据库、短信和微信授权都通过部署门禁后才会开放。")
        }
    }
}

@Composable
private fun GuestNoticeCard() {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("不登录也能决定吃什么", style = MaterialTheme.typography.titleLarge)
            Text("登录只用于跨设备同步、身份绑定和账号数据权利；不会改变自然推荐排序。")
        }
    }
}

@Composable
private fun OtpLoginCard(
    state: AccountUiState,
    capabilities: AuthCapabilities,
    onRequestCode: (AuthIdentityType, String) -> Unit,
    onSubmit: (String) -> Unit,
    onReset: () -> Unit,
) {
    val allowed = buildList {
        if (capabilities.phoneEnabled) add(AuthIdentityType.PHONE)
        if (capabilities.emailEnabled) add(AuthIdentityType.EMAIL)
    }
    var type by remember(allowed) { mutableStateOf(allowed.firstOrNull() ?: AuthIdentityType.PHONE) }
    var target by remember(type) { mutableStateOf("") }
    var otp by remember { mutableStateOf("") }
    val challenge = state.challenge?.takeIf { it.purpose == OtpPurpose.LOGIN }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("验证码登录", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            if (allowed.size > 1 && challenge == null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    allowed.forEach { option ->
                        FilterChip(
                            selected = type == option,
                            onClick = { type = option },
                            label = { Text(option.displayName()) },
                        )
                    }
                }
            }
            if (allowed.isEmpty()) {
                Text("当前没有可用的验证码登录渠道。")
            } else if (challenge == null) {
                OutlinedTextField(
                    value = target,
                    onValueChange = { target = it.take(254) },
                    label = { Text(if (type == AuthIdentityType.PHONE) "+86 手机号" else "邮箱") },
                    supportingText = {
                        Text(if (type == AuthIdentityType.PHONE) "示例：+8613800138000" else "邮箱只能登录已绑定账号")
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (type == AuthIdentityType.PHONE) KeyboardType.Phone else KeyboardType.Email,
                    ),
                    singleLine = true,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onRequestCode(type, target) },
                    enabled = target.isNotBlank() && !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("发送验证码") }
            } else {
                Text("验证码已发送至 ${challenge.maskedTarget}")
                OutlinedTextField(
                    value = otp,
                    onValueChange = { otp = it.filter(Char::isDigit).take(6) },
                    label = { Text("6 位验证码") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    singleLine = true,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onSubmit(otp) },
                    enabled = otp.length == 6 && !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("安全登录") }
                TextButton(onClick = onReset, enabled = !state.busy) { Text("更换账号") }
            }
        }
    }
}

@Composable
private fun WechatLoginCard(
    serverEnabled: Boolean,
    clientConfigured: Boolean,
    busy: Boolean,
    onLogin: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("微信登录", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text("仅能登录已经绑定微信的账号；不会自动创建或静默合并账号。")
            when {
                !serverEnabled -> Text(
                    "当前服务端尚未开放微信登录。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                !clientConfigured -> Text(
                    "此安装包未配置微信开放平台 AppID，微信能力已安全关闭。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> Button(
                    onClick = onLogin,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("使用微信安全登录") }
            }
        }
    }
}

@Composable
private fun PhoneWechatRegistrationCard(
    state: AccountUiState,
    capabilities: AuthCapabilities,
    onRequestCode: (String) -> Unit,
    onAuthorizeAndRegister: (String) -> Unit,
    onReset: () -> Unit,
) {
    var phone by remember { mutableStateOf("") }
    var otp by remember { mutableStateOf("") }
    val challenge = state.challenge?.takeIf {
        it.purpose == OtpPurpose.REGISTER && it.type == AuthIdentityType.PHONE
    }
    val available = capabilities.registrationEnabled &&
        capabilities.phoneEnabled &&
        capabilities.wechatEnabled &&
        state.wechatClientConfigured

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("创建账号", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text("新账号必须按顺序完成手机号验证码和微信授权；两份证明只在同一注册流程中一次性配对。")
            if (!available) {
                Text(
                    when {
                        !capabilities.registrationEnabled -> "当前部署尚未开放账号注册，游客功能不受影响。"
                        !capabilities.phoneEnabled -> "当前手机号验证渠道尚未开放。"
                        !capabilities.wechatEnabled -> "当前服务端尚未开放微信注册。"
                        else -> "此安装包未配置微信开放平台 AppID，注册已安全关闭。"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else if (challenge == null) {
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it.take(14) },
                    label = { Text("+86 手机号") },
                    supportingText = { Text("示例：+8613800138000") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    singleLine = true,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onRequestCode(phone) },
                    enabled = phone.isNotBlank() && !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("发送注册验证码") }
            } else {
                Text("验证码已发送至 ${challenge.maskedTarget}")
                OutlinedTextField(
                    value = otp,
                    onValueChange = { otp = it.filter(Char::isDigit).take(6) },
                    label = { Text("6 位验证码") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    singleLine = true,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onAuthorizeAndRegister(otp) },
                    enabled = otp.length == 6 && !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("微信授权并创建账号") }
                TextButton(onClick = onReset, enabled = !state.busy) { Text("更换手机号") }
            }
        }
    }
}

@Composable
private fun QqLoginCard(
    serverEnabled: Boolean,
    clientConfigured: Boolean,
    hostAvailable: Boolean,
    busy: Boolean,
    onLogin: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("QQ 登录", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text("仅能登录已经绑定 QQ 的账号；QQ 不能创建新账号，也不会触发静默合并。")
            QqAvailabilityContent(
                serverEnabled = serverEnabled,
                clientConfigured = clientConfigured,
                hostAvailable = hostAvailable,
                actionLabel = "使用 QQ 安全登录",
                busy = busy,
                onAction = onLogin,
            )
        }
    }
}

@Composable
private fun BindQqCard(
    serverEnabled: Boolean,
    clientConfigured: Boolean,
    hostAvailable: Boolean,
    busy: Boolean,
    onBind: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("绑定 QQ", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text("绑定后可使用 QQ 登录；若该 QQ 已属于其他账号，系统会拒绝且不会静默合并。")
            QqAvailabilityContent(
                serverEnabled = serverEnabled,
                clientConfigured = clientConfigured,
                hostAvailable = hostAvailable,
                actionLabel = "前往 QQ 验证绑定",
                busy = busy,
                onAction = onBind,
            )
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
        !serverEnabled -> Text(
            "当前服务端尚未开放 QQ 登录与绑定，游客推荐不受影响。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        !clientConfigured -> Text(
            "此安装包未配置腾讯 QQ 互联 AppID，QQ 能力已安全关闭。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        !hostAvailable -> Text(
            "当前页面环境无法安全调起 QQ，请重新打开账号页。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        else -> Button(
            onClick = onAction,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(actionLabel) }
    }
}

@Composable
private fun SignedInCard(onRefresh: () -> Unit, busy: Boolean) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Icons.Rounded.Lock, null, tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f)) {
                Text("已安全登录", style = MaterialTheme.typography.titleLarge)
                Text("访问令牌只保存在内存，刷新令牌由 Android Keystore 加密。")
            }
            TextButton(onClick = onRefresh, enabled = !busy) { Text("刷新") }
        }
    }
}

@Composable
private fun IdentityCard(
    identities: List<AuthIdentityBinding>,
    onUnbind: (AuthIdentityBinding) -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("登录身份", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            if (identities.isEmpty()) {
                Text("暂未取得身份列表", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            identities.forEachIndexed { index, identity ->
                if (index > 0) HorizontalDivider()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${identity.type.displayName()} · ${identity.maskedValue}")
                        Text(
                            if (identity.primary) "主身份，不可解绑" else "已验证绑定",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (identity.canUnbind) {
                        TextButton(onClick = { onUnbind(identity) }) { Text("解绑") }
                    }
                }
            }
        }
    }
}

@Composable
private fun BindEmailCard(
    state: AccountUiState,
    onRequestCode: (String) -> Unit,
    onSubmit: (String) -> Unit,
    onReset: () -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var otp by remember { mutableStateOf("") }
    val challenge = state.challenge?.takeIf {
        it.purpose == OtpPurpose.BIND && it.type == AuthIdentityType.EMAIL
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("绑定邮箱", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text("邮箱只能在现有账号内验证绑定，不能单独创建新账号。")
            if (challenge == null) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it.take(254) },
                    label = { Text("邮箱") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    singleLine = true,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onRequestCode(email) },
                    enabled = email.isNotBlank() && !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("发送绑定验证码") }
            } else {
                Text("验证码已发送至 ${challenge.maskedTarget}")
                OutlinedTextField(
                    value = otp,
                    onValueChange = { otp = it.filter(Char::isDigit).take(6) },
                    label = { Text("6 位验证码") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onSubmit(otp) },
                    enabled = otp.length == 6 && !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("确认绑定") }
                TextButton(onClick = onReset) { Text("取消") }
            }
        }
    }
}

@Composable
private fun SessionsCard(
    sessions: List<AuthSessionSummary>,
    onRevoke: (AuthSessionSummary) -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("登录设备", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            if (sessions.isEmpty()) Text("暂未取得设备列表")
            sessions.forEachIndexed { index, session ->
                if (index > 0) HorizontalDivider()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(session.deviceLabel)
                        Text(
                            "${if (session.current) "当前设备" else session.platform} · 最近 ${formatInstant(session.lastActiveAt)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (!session.current) {
                        TextButton(onClick = { onRevoke(session) }) { Text("退出") }
                    }
                }
            }
        }
    }
}

@Composable
private fun DataRightsCard(
    export: AccountExportStatusResponse?,
    dataExportEnabled: Boolean,
    accountDeletionAvailable: Boolean,
    includeBehaviorHistory: Boolean,
    busy: Boolean,
    onIncludeBehaviorHistoryChange: (Boolean) -> Unit,
    onExport: () -> Unit,
    onRefresh: () -> Unit,
    onDownload: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("账号数据权利", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            if (dataExportEnabled) {
                Text("可申请 JSON 数据导出；文件最长保留 7 天，大小上限为 10 MiB。")
                Text(
                    "导出不包含登录令牌、第三方原始标识、精确位置或内部安全字段。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                FilterChip(
                    selected = includeBehaviorHistory,
                    onClick = { onIncludeBehaviorHistoryChange(!includeBehaviorHistory) },
                    enabled = !busy,
                    label = { Text("包含近 90 天推荐行为记录") },
                )
                when (export) {
                    null -> Text("当前没有数据导出任务")
                    else -> {
                        Text(
                            "最近导出：${export.status.displayName()}",
                            fontWeight = FontWeight.SemiBold,
                        )
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
                            AccountExportStatus.QUEUED -> Text("任务正在排队，可稍后刷新。")
                            AccountExportStatus.PROCESSING -> Text("正在生成文件，可稍后刷新。")
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
                                Button(
                                    onClick = onDownload,
                                    enabled = !busy && export.downloadAvailable,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Text("选择保存位置并下载")
                                }
                            }
                            AccountExportStatus.FAILED -> Text("文件生成失败，可重新申请。")
                            AccountExportStatus.EXPIRED -> Text("文件已过期，请重新申请。")
                        }
                    }
                }
                if (busy) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator()
                        Spacer(Modifier.width(10.dp))
                        Text("正在安全处理数据导出…")
                    }
                }
                OutlinedButton(onClick = onRefresh, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text("刷新导出状态")
                }
                OutlinedButton(
                    onClick = onExport,
                    enabled = !busy && export?.status !in setOf(
                        AccountExportStatus.QUEUED,
                        AccountExportStatus.PROCESSING,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (export == null) "申请数据导出" else "重新申请数据导出")
                }
            } else {
                Text("数据导出当前未开放")
                Text(
                    "服务端尚未开放安全的数据导出通道；其他账号权利不受影响。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (!accountDeletionAvailable) {
                Text(
                    "账号服务已明确关闭，注销请求暂时无法安全鉴权；请勿卸载 App，并联系运营方处理数据权利请求。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            TextButton(
                onClick = onDelete,
                enabled = !busy && accountDeletionAvailable,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Rounded.Delete, null, tint = MaterialTheme.colorScheme.error)
                Spacer(Modifier.width(6.dp))
                Text("注销账号", color = MaterialTheme.colorScheme.error)
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
    AlertDialog(
        onDismissRequest = onDismiss,
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

private val ACCOUNT_TIME_FORMATTER = DateTimeFormatter
    .ofPattern("MM-dd HH:mm")
    .withZone(ZoneId.systemDefault())
