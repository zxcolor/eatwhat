package com.chishenme.app.feature.account

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.ui.AppSnackbarHost

/** Callbacks keep presentation independent of credentials, SDKs and session storage. */
data class AuthLandingActions(
    val onBack: () -> Unit,
    val onPrivacy: () -> Unit,
    val onRequestCode: (AuthIdentityType, String) -> Unit,
    val onSubmit: (String) -> Unit,
    val onResend: () -> Unit,
    val onResetChallenge: () -> Unit,
    val onSelectType: (AuthIdentityType) -> Unit,
    val onTargetChange: (AuthIdentityType, String) -> Unit,
    val onOtpChange: (String) -> Unit,
    val onLogin: () -> Unit,
    val onRegister: () -> Unit,
    val onWechatLogin: () -> Unit,
    val onQqLogin: () -> Unit,
    val onWechatBind: () -> Unit,
    val onRefreshIdentities: () -> Unit,
    val onFinish: () -> Unit,
    val onNotice: (String) -> Unit,
)

@Composable
fun AuthSurfaceTheme(content: @Composable () -> Unit) {
    val base = MaterialTheme.colorScheme
    val dark = base.background.luminance() < 0.5f
    MaterialTheme(
        colorScheme = base.copy(
            background = if (dark) Color(0xFF181411) else Color(0xFFFFFDFC),
            onBackground = if (dark) Color(0xFFF4E9E0) else Color(0xFF3D2517),
            surface = if (dark) Color(0xFF29221D) else Color.White,
            onSurface = if (dark) Color(0xFFF4E9E0) else Color(0xFF3D2517),
            onSurfaceVariant = if (dark) Color(0xFFCDBAAD) else Color(0xFF785D4C),
            primary = if (dark) Color(0xFFEED6C3) else Color(0xFF472A19),
            onPrimary = if (dark) Color(0xFF382317) else Color.White,
            secondary = if (dark) Color(0xFFFFAD87) else Color(0xFFBB4018),
            outline = if (dark) Color(0xFFB49D8D) else Color(0xFF8C7769),
            outlineVariant = if (dark) Color(0xFF514237) else Color(0xFFE7DFD9),
        ),
        content = content,
    )
}

/** Native, scrollable counterpart of the approved login and registration mockups. */
@Composable
fun AccountAuthLanding(
    state: AccountUiState,
    capabilities: AuthCapabilities?,
    qqHostAvailable: Boolean,
    snackbar: SnackbarHostState,
    actions: AuthLandingActions,
) {
    var consentAccepted by remember { mutableStateOf(false) }
    val registering = state.entryMode == AccountEntryMode.REGISTER
    val signedInRegistration = registering && state.status == AccountStatus.SIGNED_IN
    val step = if (signedInRegistration) state.registrationStep else AccountRegistrationStep.PHONE
    val canUseAccount = capabilities?.accountsEnabled == true
    val focus = LocalFocusManager.current
    val notice: (String) -> Unit = actions.onNotice
    BackHandler(onBack = actions.onBack)

    AuthSurfaceTheme {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
        ) { insets ->
            BoxWithConstraints(
                Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets).imePadding(),
                contentAlignment = Alignment.TopCenter,
            ) {
                val availableHeight = maxHeight
                Column(
                    Modifier.widthIn(max = 480.dp).fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .heightIn(min = availableHeight)
                        .padding(horizontal = 24.dp),
                ) {
                    IconButton(
                        onClick = actions.onBack,
                        modifier = Modifier.padding(top = 4.dp).size(48.dp).testTag("auth-back"),
                    ) {
                        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, "返回", Modifier.size(30.dp))
                    }
                    Spacer(Modifier.height((availableHeight * 0.085f).coerceIn(20.dp, 70.dp)))
                    Text(
                        if (registering) "注册" else "登录",
                        style = MaterialTheme.typography.displaySmall.copy(fontSize = 40.sp, lineHeight = 50.sp),
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.semantics { heading() }.testTag("auth-title"),
                    )
                    if (registering) {
                        Spacer(Modifier.height(14.dp))
                        RegistrationProgress(step)
                        Spacer(Modifier.height(20.dp))
                    } else {
                        Spacer(Modifier.height(34.dp))
                    }

                    when {
                        signedInRegistration && step == AccountRegistrationStep.SUCCESS -> {
                            RegistrationResultCard(success = true)
                            Spacer(Modifier.height(24.dp))
                            AuthPrimaryButton("开始使用", true, false, actions.onFinish)
                        }
                        signedInRegistration -> {
                            RegistrationResultCard(success = false)
                            Spacer(Modifier.height(24.dp))
                            val unavailable = when {
                                !canUseAccount -> "账号服务暂不可用，请稍后重试"
                                capabilities?.wechatEnabled != true -> "微信绑定暂未开放"
                                !state.wechatClientConfigured -> "当前安装包暂不支持微信绑定"
                                else -> null
                            }
                            AuthPrimaryButton(
                                text = if (!state.identitiesLoaded && !state.busy) "重试加载" else "绑定微信",
                                enabled = !state.busy && canUseAccount &&
                                    (!state.identitiesLoaded || consentAccepted && unavailable == null),
                                busy = state.busy,
                                onClick = {
                                    if (!state.identitiesLoaded) actions.onRefreshIdentities()
                                    else if (consentAccepted && unavailable == null) actions.onWechatBind()
                                },
                            )
                            if (unavailable != null) AuthStatusText(unavailable)
                            else if (!state.identitiesLoaded && !state.busy) {
                                AuthStatusText("暂未取得绑定状态，请重试")
                            }
                        }
                        else -> {
                            AuthOtpForm(state, capabilities, registering, consentAccepted, actions)
                            if (registering || capabilities?.registrationEnabled == true) {
                                Row(
                                    Modifier.fillMaxWidth().padding(top = 10.dp),
                                    horizontalArrangement = Arrangement.Center,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(if (registering) "已有账号？" else "还没有账号？", style = MaterialTheme.typography.bodyMedium)
                                    TextButton(
                                        onClick = {
                                            focus.clearFocus()
                                            if (registering) actions.onLogin() else actions.onRegister()
                                        },
                                        enabled = !state.busy,
                                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.secondary),
                                        modifier = Modifier.testTag("auth-switch-mode"),
                                    ) { Text(if (registering) "登录" else "注册") }
                                }
                            }
                        }
                    }

                    // Feedback participates in the form layout so it cannot intercept touches
                    // on fields or channel controls when the keyboard changes the viewport.
                    AppSnackbarHost(snackbar, Modifier.fillMaxWidth())
                    Spacer(Modifier.height(32.dp))
                    Spacer(Modifier.weight(1f))
                    Column(Modifier.fillMaxWidth()) {
                        AuthConsentRow(
                            checked = consentAccepted,
                            enabled = !state.busy,
                            onChecked = { consentAccepted = it },
                            onPrivacy = actions.onPrivacy,
                        )
                        if (!registering) {
                            Spacer(Modifier.height(12.dp))
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(34.dp, Alignment.CenterHorizontally),
                            ) {
                                AuthProviderButton("微信登录", "auth-wechat", !state.busy,
                                    canUseAccount && capabilities?.wechatEnabled == true && state.wechatClientConfigured,
                                    onClick = {
                                        when {
                                            !consentAccepted -> notice("请先阅读并同意隐私政策")
                                            !canUseAccount || capabilities?.wechatEnabled != true -> notice("微信登录暂未开放")
                                            !state.wechatClientConfigured -> notice("当前安装包暂不支持微信登录")
                                            else -> actions.onWechatLogin()
                                        }
                                    },
                                ) { WechatAuthIcon(Modifier.size(28.dp)) }
                                AuthProviderButton("QQ 登录", "auth-qq", !state.busy,
                                    canUseAccount && capabilities?.qqEnabled == true && state.qqClientConfigured && qqHostAvailable,
                                    onClick = {
                                        when {
                                            !consentAccepted -> notice("请先阅读并同意隐私政策")
                                            !canUseAccount || capabilities?.qqEnabled != true -> notice("QQ 登录暂未开放")
                                            !state.qqClientConfigured || !qqHostAvailable -> notice("当前安装包暂不支持 QQ 登录")
                                            else -> actions.onQqLogin()
                                        }
                                    },
                                ) { QqAuthIcon(Modifier.size(28.dp)) }
                                val email = (state.challenge?.type ?: state.otpInputType) == AuthIdentityType.EMAIL
                                AuthProviderButton(
                                    if (email) "手机号登录" else "邮箱登录", "auth-switch-channel", !state.busy,
                                    if (email) capabilities?.phoneEnabled == true && capabilities.registrationEnabled
                                    else capabilities?.emailEnabled == true,
                                    onClick = {
                                        val available = if (email) capabilities?.phoneEnabled == true && capabilities.registrationEnabled
                                        else capabilities?.emailEnabled == true
                                        if (available) {
                                            focus.clearFocus()
                                            actions.onSelectType(if (email) AuthIdentityType.PHONE else AuthIdentityType.EMAIL)
                                        } else notice(if (email) "手机号登录暂未开放" else "邮箱登录暂未开放")
                                    },
                                ) {
                                    Icon(if (email) Icons.Outlined.Phone else Icons.Outlined.Email, null, Modifier.size(26.dp))
                                }
                            }
                            Spacer(Modifier.height(36.dp))
                        } else {
                            Spacer(Modifier.height(12.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AuthOtpForm(
    state: AccountUiState,
    capabilities: AuthCapabilities?,
    registering: Boolean,
    consent: Boolean,
    actions: AuthLandingActions,
) {
    val type = if (registering) AuthIdentityType.PHONE
    else state.challenge?.type ?: state.otpInputType ?: AuthIdentityType.PHONE
    val phone = type == AuthIdentityType.PHONE
    val available = capabilities?.accountsEnabled == true && if (phone) {
        capabilities.phoneEnabled && capabilities.registrationEnabled
    } else capabilities.emailEnabled
    val challenge = state.challenge?.takeIf {
        it.type == type && (it.purpose == OtpPurpose.REGISTER || it.purpose == OtpPurpose.LOGIN)
    }
    val target = if (state.otpInputType == type) state.otpTargetDraft else ""
    val displayTarget = challenge?.maskedTarget ?: target
    val validTarget = if (phone) target.matches(Regex("^(?:\\+86)?1[3-9]\\d{9}$"))
    else target.matches(Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"))
    val validCode = state.otpCodeDraft.matches(Regex("^[0-9]{6}$"))
    val canSubmit = consent && available && challenge != null && validCode &&
        state.otpSecondsUntilExpiry > 0 && !state.busy
    val focus = LocalFocusManager.current
    AuthFieldSurface {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(38.dp), contentAlignment = Alignment.CenterStart) {
                if (phone) Text("+86", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                else Icon(Icons.Outlined.Email, null, Modifier.size(24.dp))
            }
            Spacer(Modifier.width(10.dp))
            AuthFieldDivider()
            Spacer(Modifier.width(16.dp))
            AuthTextInput(
                value = displayTarget,
                onChange = { actions.onTargetChange(type, it) },
                label = if (phone) "手机号" else "邮箱地址",
                enabled = !state.busy && available && challenge == null,
                keyboard = if (phone) KeyboardType.Phone else KeyboardType.Email,
                modifier = Modifier.weight(1f).testTag("auth-target"),
            )
        }
    }
    Spacer(Modifier.height(14.dp))
    AuthFieldSurface {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            AuthTextInput(
                value = state.otpCodeDraft,
                onChange = actions.onOtpChange,
                label = "6 位验证码",
                enabled = available && !state.busy && challenge != null,
                keyboard = KeyboardType.NumberPassword,
                modifier = Modifier.weight(1f).testTag("auth-code"),
                onDone = { if (canSubmit) { focus.clearFocus(); actions.onSubmit(state.otpCodeDraft) } },
            )
            Spacer(Modifier.width(8.dp))
            AuthFieldDivider()
            TextButton(
                onClick = {
                    focus.clearFocus()
                    if (challenge == null) actions.onRequestCode(type, target) else actions.onResend()
                },
                enabled = consent && available && !state.busy && if (challenge == null) validTarget
                else state.otpCanResend && state.otpSecondsUntilResend == 0L,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.secondary),
                contentPadding = PaddingValues(horizontal = 10.dp),
                modifier = Modifier.heightIn(min = 48.dp).testTag("auth-send-code"),
            ) {
                Text(
                    when {
                        challenge == null -> "获取验证码"
                        state.otpSecondsUntilResend > 0 -> "${state.otpSecondsUntilResend}s 后重发"
                        else -> "重新获取"
                    },
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
    if (challenge != null) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (state.otpSecondsUntilExpiry > 0) "验证码已发送至 ${challenge.maskedTarget}" else "验证码已过期，请重新获取",
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = actions.onResetChallenge, enabled = !state.busy) { Text("更换账号") }
        }
    }
    if (!available) AuthStatusText(if (phone) "手机号登录暂未开放" else "邮箱登录暂未开放")
    Spacer(Modifier.height(26.dp))
    AuthPrimaryButton(if (registering) "下一步" else "登录", canSubmit, state.busy) {
        focus.clearFocus()
        actions.onSubmit(state.otpCodeDraft)
    }
}

@Composable
private fun AuthTextInput(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    enabled: Boolean,
    keyboard: KeyboardType,
    modifier: Modifier,
    onDone: (() -> Unit)? = null,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        modifier = modifier.heightIn(min = 48.dp).semantics { contentDescription = label },
        enabled = enabled,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.secondary),
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = if (onDone == null) ImeAction.Next else ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        decorationBox = { input ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
                input()
            }
        },
    )
}

@Composable
private fun AuthFieldSurface(content: @Composable () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().heightIn(min = 58.dp),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 3.dp,
        content = content,
    )
}

@Composable
private fun AuthFieldDivider() {
    Box(Modifier.width(1.dp).height(22.dp).background(MaterialTheme.colorScheme.outlineVariant))
}

@Composable
private fun AuthPrimaryButton(text: String, enabled: Boolean, busy: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp).testTag("auth-primary"),
        shape = RoundedCornerShape(18.dp),
        colors = ButtonDefaults.buttonColors(
            disabledContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.72f),
            disabledContentColor = MaterialTheme.colorScheme.onPrimary,
        ),
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
        }
        Text(if (busy) "正在验证…" else text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun AuthProviderButton(
    label: String,
    tag: String,
    enabled: Boolean,
    available: Boolean,
    onClick: () -> Unit,
    icon: @Composable () -> Unit,
) {
    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
        IconButton(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.size(56.dp).testTag(tag).semantics {
                contentDescription = label
                if (!available) stateDescription = "暂不可用"
            },
        ) { icon() }
    }
}

@Composable
private fun AuthConsentRow(checked: Boolean, enabled: Boolean, onChecked: (Boolean) -> Unit, onPrivacy: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(48.dp).testTag("auth-consent")
                .toggleable(checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChecked)
                .semantics { contentDescription = "我已阅读并同意隐私政策" },
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                modifier = Modifier.size(19.dp), shape = CircleShape,
                color = if (checked) MaterialTheme.colorScheme.primary else Color.Transparent,
                border = if (checked) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            ) { if (checked) Icon(Icons.Rounded.Check, null, Modifier.padding(3.dp), tint = MaterialTheme.colorScheme.onPrimary) }
        }
        Text("我已阅读并同意", style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onPrivacy, contentPadding = PaddingValues(horizontal = 4.dp), modifier = Modifier.heightIn(min = 48.dp)) {
            Text("《隐私政策》", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
        }
    }
}

@Composable
private fun RegistrationProgress(step: AccountRegistrationStep) {
    val labels = listOf("验证手机号", "绑定微信", "注册成功")
    val stacked = LocalDensity.current.fontScale > 1.15f
    Row(Modifier.fillMaxWidth().testTag("auth-progress"), verticalAlignment = Alignment.CenterVertically) {
        labels.forEachIndexed { index, label ->
            val completed = index < step.ordinal
            val active = index == step.ordinal
            val color = if (active || completed) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
            val marker: @Composable () -> Unit = {
                Surface(
                    modifier = Modifier.size(23.dp), shape = CircleShape,
                    color = if (active) MaterialTheme.colorScheme.secondary else Color.Transparent,
                    border = if (active) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        if (completed) Icon(Icons.Rounded.Check, null, Modifier.size(15.dp), tint = color)
                        else Text("${index + 1}", fontSize = 12.sp, color = if (active) MaterialTheme.colorScheme.background else color)
                    }
                }
            }
            val description = "$label，${if (completed) "已完成" else if (active) "当前步骤" else "未完成"}"
            if (stacked) {
                Column(Modifier.weight(1f).semantics(mergeDescendants = true) { contentDescription = description }, horizontalAlignment = Alignment.CenterHorizontally) {
                    marker()
                    Spacer(Modifier.height(6.dp))
                    Text(label, fontSize = 12.sp, textAlign = TextAlign.Center, color = color)
                }
            } else {
                Row(Modifier.weight(1f).semantics(mergeDescendants = true) { contentDescription = description }, verticalAlignment = Alignment.CenterVertically) {
                    marker()
                    Spacer(Modifier.width(5.dp))
                    Text(label, fontSize = 12.sp, color = color)
                }
            }
            if (index < labels.lastIndex) {
                Box(Modifier.padding(horizontal = 3.dp).width(12.dp).height(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
            }
        }
    }
}

@Composable
private fun RegistrationResultCard(success: Boolean) {
    AuthFieldSurface {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (success) {
                Icon(Icons.Rounded.Check, null, Modifier.size(54.dp), tint = Color(0xFF07C160))
            } else WechatAuthIcon(Modifier.size(54.dp))
            Spacer(Modifier.height(22.dp))
            Text(if (success) "注册成功" else "手机号已验证", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(10.dp))
            Text(
                if (success) "已完成手机号验证与微信绑定" else "绑定微信，完成注册",
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun AuthStatusText(text: String) {
    Text(
        text, modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}
