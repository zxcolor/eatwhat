package com.chishenme.app.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.List
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.chishenme.app.BuildConfig
import com.chishenme.app.data.local.DecisionHistoryEntry
import com.chishenme.app.data.local.ThemePreference
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.domain.AppVersionPolicy
import com.chishenme.app.domain.AppVersionStatus
import com.chishenme.app.feature.consent.THIRD_PARTY_SERVICE_DISCLOSURE
import com.chishenme.app.feature.support.showSupportFeedbackEntryAction
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppDialog
import com.chishenme.app.ui.AppHeroCard
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppSectionHeader
import com.chishenme.app.ui.AppTopBar
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private enum class SettingsDocument { PRIVACY, DATA_SOURCES, ALGORITHM, SDK, HELP, CHANGELOG, VERSION }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    aiEnabled: Boolean,
    aiServiceAvailable: Boolean,
    theme: ThemePreference,
    onAiEnabledChange: (Boolean) -> Unit,
    onThemeChange: (ThemePreference) -> Unit,
    onBack: () -> Unit,
    onWithdrawPrivacy: () -> Unit,
    decisionHistory: List<DecisionHistoryEntry>,
    onClearDecisionHistory: () -> Unit,
    onOpenAccount: () -> Unit,
    onOpenSavedResources: () -> Unit,
    onOpenSupportFeedback: () -> Unit,
    supportFeedbackEnabled: Boolean,
    minimumSupportedVersion: String?,
) {
    var document by remember { mutableStateOf<SettingsDocument?>(null) }
    var confirmWithdraw by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            AppTopBar(
                title = "设置与透明度",
                subtitle = "隐私、数据、账户与显示",
                onBack = onBack,
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(
                horizontal = AppDimens.ScreenHorizontal,
                vertical = AppDimens.ScreenVertical,
            ),
            verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
        ) {
            item {
                AppHeroCard(
                    eyebrow = "CONTROL CENTER",
                    title = "你的选择，始终由你掌控",
                    description = "权限按需开启，数据边界清晰可查；账号、历史和主题都能在这里独立管理。",
                    icon = Icons.Rounded.Lock,
                )
            }
            item { SettingsHeader("隐私控制") }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Lock, null) },
                    title = "账号与安全",
                    description = "游客可直接使用；登录后可管理验证身份、登录设备、数据导出和账号注销。",
                    action = { TextButton(onClick = onOpenAccount) { Text("管理") } },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Star, null) },
                    title = "收藏、账号历史与私有反馈",
                    description = "登录后查看或删除账号记录；与本机最近决策分开，不会静默合并上传。",
                    action = { TextButton(onClick = onOpenSavedResources) { Text("管理") } },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Info, null) },
                    title = "问题反馈与餐厅纠错",
                    description = if (supportFeedbackEnabled) {
                        "游客也可提交；正文仅在当前页面内存中编辑，不保存到本机历史。"
                    } else {
                        "反馈服务尚未完成就绪确认，当前不会开放任何提交入口。"
                    },
                    action = {
                        if (showSupportFeedbackEntryAction(supportFeedbackEnabled)) {
                            TextButton(onClick = onOpenSupportFeedback) { Text("提交") }
                        } else {
                            Text(
                                "当前未开放",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.LocationOn, null) },
                    title = "定位能力",
                    description = "使用 Android 系统原生前台定位。只有你点击“自动定位”时才申请位置权限；大致位置和手动选址都可完成推荐，坐标不会保存。",
                    action = { Text("按需启用", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Star, null) },
                    title = "AI 辅助偏好",
                    description = if (aiServiceAvailable) {
                        "保存在本机。关闭后请求会明确禁止 AI；服务失败会回退到规则引擎。"
                    } else {
                        "服务端 AI 当前关闭或远程配置不可用，本次只使用规则引擎。"
                    },
                    action = {
                        Switch(
                            checked = aiEnabled && aiServiceAvailable,
                            onCheckedChange = onAiEnabledChange,
                            enabled = aiServiceAvailable,
                            modifier = Modifier.semantics {
                                contentDescription = "AI 辅助偏好"
                            },
                        )
                    },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Lock, null) },
                    title = "隐私政策",
                    description = "查看位置、事件、账号与保留期限说明。",
                    action = { TextButton(onClick = { document = SettingsDocument.PRIVACY }) { Text("查看") } },
                )
            }

            item { SettingsHeader("本机数据") }
            item {
                DecisionHistoryCard(
                    entries = decisionHistory,
                    onClear = onClearDecisionHistory,
                )
            }

            item { SettingsHeader("推荐透明度") }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Info, null) },
                    title = "数据来源",
                    description = "演示数据与未来经授权的数据会分开标识，不合并伪装评分。",
                    action = { TextButton(onClick = { document = SettingsDocument.DATA_SOURCES }) { Text("查看") } },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.AutoMirrored.Rounded.List, null) },
                    title = "推荐规则摘要",
                    description = "先执行营业、距离、预算和排除项硬规则，再做可解释排序。",
                    action = { TextButton(onClick = { document = SettingsDocument.ALGORITHM }) { Text("查看") } },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Lock, null) },
                    title = "第三方服务清单",
                    description = "同意前不会调用高德 Web Service、验证码投递或微信/QQ 登录能力。",
                    action = { TextButton(onClick = { document = SettingsDocument.SDK }) { Text("查看") } },
                )
            }

            item { SettingsHeader("显示") }
            item {
                AppCard(contentPadding = PaddingValues(0.dp)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(AppIcons.DarkMode, null, tint = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(10.dp))
                            Text("外观模式", style = MaterialTheme.typography.titleMedium)
                        }
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            contentPadding = PaddingValues(end = 4.dp),
                        ) {
                            items(ThemePreference.entries) { option ->
                                FilterChip(
                                    selected = theme == option,
                                    onClick = { onThemeChange(option) },
                                    leadingIcon = if (theme == option) {
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
                                    label = {
                                        Text(
                                            when (option) {
                                                ThemePreference.SYSTEM -> "跟随系统"
                                                ThemePreference.LIGHT -> "浅色"
                                                ThemePreference.DARK -> "深色"
                                            },
                                        )
                                    },
                                )
                            }
                        }
                    }
                }
            }

            item { SettingsHeader("关于") }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Info, null) },
                    title = "使用帮助",
                    description = "查看定位、无结果、弱网和账号问题的自助处理方法。",
                    action = { TextButton(onClick = { document = SettingsDocument.HELP }) { Text("查看") } },
                )
            }
            item {
                val versionStatus = AppVersionPolicy.evaluate(
                    currentVersion = BuildConfig.VERSION_NAME,
                    minimumVersion = minimumSupportedVersion,
                )
                SettingsCard(
                    icon = { Icon(Icons.AutoMirrored.Rounded.List, null) },
                    title = "版本兼容性",
                    description = versionStatus.description(),
                    action = { TextButton(onClick = { document = SettingsDocument.VERSION }) { Text("检查") } },
                )
            }
            item {
                SettingsCard(
                    icon = { Icon(Icons.Rounded.Info, null) },
                    title = "更新日志",
                    description = "查看当前邀请测试版本已实现的主要能力。",
                    action = { TextButton(onClick = { document = SettingsDocument.CHANGELOG }) { Text("查看") } },
                )
            }
            item {
                AppCard(contentPadding = PaddingValues(0.dp)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("吃什么 · 附近美食决策", style = MaterialTheme.typography.titleMedium)
                        Text("版本 ${BuildConfig.VERSION_NAME}")
                        Text(
                            "当前为邀请测试工程。未完成 App 备案和数据授权门禁前不公开发布 APK。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        HorizontalDivider()
                        Text("游客核心推荐无需注册，也不会申请系统通知权限。")
                    }
                }
            }
            item {
                OutlinedButton(
                    onClick = { confirmWithdraw = true },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("撤回隐私同意", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }

    document?.let { selected ->
        SettingsDocumentDialog(
            document = selected,
            minimumSupportedVersion = minimumSupportedVersion,
            onDismiss = { document = null },
        )
    }
    if (confirmWithdraw) {
        AppDialog(
            onDismissRequest = { confirmWithdraw = false },
            title = { Text("撤回隐私同意？") },
            text = { Text("撤回后立即回到首次隐私页面，推荐网络层将不再被界面调用，本机最近决策会清空；主题偏好会保留。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmWithdraw = false
                    onWithdrawPrivacy()
                }) { Text("确认撤回", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmWithdraw = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun DecisionHistoryCard(
    entries: List<DecisionHistoryEntry>,
    onClear: () -> Unit,
) {
    AppCard(contentPadding = PaddingValues(0.dp)) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(AppIcons.AccessTime, null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("最近决策", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "仅保留时间与决策摘要，最多 30 条、90 天；不保存位置或餐厅信息。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (entries.isNotEmpty()) {
                    TextButton(onClick = onClear) {
                        Icon(Icons.Rounded.Delete, null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("清空")
                    }
                }
            }

            if (entries.isEmpty()) {
                Text(
                    "暂无最近决策",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                entries.forEach { entry ->
                    HorizontalDivider()
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "${formatHistoryTime(entry.recordedAtEpochMillis)} · ${entry.mealPeriod.displayName()}",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                entry.summary(),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(
                            "${entry.resultCount} 个结果",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
        }
    }
}

private fun DecisionHistoryEntry.summary(): String = listOf(
    decisionMode.displayName(),
    budgetMaxYuan?.let { "预算 ¥$it/人" } ?: "预算不限",
    "$availableMinutes 分钟",
    travelMode.displayName(),
).joinToString(" · ")

private fun MealPeriod.displayName(): String = when (this) {
    MealPeriod.BREAKFAST -> "早餐"
    MealPeriod.LUNCH -> "午餐"
    MealPeriod.DINNER -> "晚餐"
}

private fun DecisionMode.displayName(): String = when (this) {
    DecisionMode.QUICK -> "快速决策"
    DecisionMode.GUIDED -> "引导决策"
}

private fun TravelMode.displayName(): String = when (this) {
    TravelMode.WALK -> "步行"
    TravelMode.BIKE -> "骑行"
    TravelMode.TRANSIT -> "公交"
}

private fun formatHistoryTime(epochMillis: Long): String = HISTORY_TIME_FORMATTER.format(
    Instant.ofEpochMilli(epochMillis),
)

private val HISTORY_TIME_FORMATTER: DateTimeFormatter = DateTimeFormatter
    .ofPattern("MM-dd HH:mm")
    .withZone(ZoneId.systemDefault())

@Composable
private fun SettingsHeader(text: String) {
    AppSectionHeader(title = text)
}

@Composable
private fun SettingsCard(
    icon: @Composable () -> Unit,
    title: String,
    description: String,
    action: @Composable () -> Unit,
) {
    AppCard(contentPadding = PaddingValues(0.dp)) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                androidx.compose.material3.Surface(
                    shape = MaterialTheme.shapes.medium,
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(42.dp),
                ) { androidx.compose.foundation.layout.Box(contentAlignment = Alignment.Center) { icon() } }
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    Text(
                        description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(
                modifier = Modifier.align(Alignment.End),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                action()
            }
        }
    }
}

@Composable
private fun SettingsDocumentDialog(
    document: SettingsDocument,
    minimumSupportedVersion: String?,
    onDismiss: () -> Unit,
) {
    val (title, body) = when (document) {
        SettingsDocument.PRIVACY -> "隐私政策摘要" to
            "精确坐标或主动选择的固定地点只存在于当次 HTTPS 地点搜索/推荐请求；AMAP 完成授权门禁并启用时，自有后端才把单次查询中心转换为 GCJ-02 后提交高德，不跨请求持久化高德 POI，坐标不写入埋点。推荐事件只发送请求 ID、有效期最多两小时且仅限原推荐请求使用的结果令牌、事件类型和时间。正式发布版本会列明运营主体、联系方式、完整保留期限和数据权利入口。"
        SettingsDocument.DATA_SOURCES -> "数据来源" to
            "当前默认使用虚构的演示餐厅（DEMO）。配置并取得高德书面授权后，才可启用 AMAP 实时数据；实时展示模式不缓存外部 POI、不展示自有适合度，也不把 POI 内容发送给模型。"
        SettingsDocument.ALGORITHM -> "推荐规则摘要" to
            "系统先排除明确停业、超出最大范围、明确超预算、用户排除菜系和重复门店。授权允许后，才根据合法质量信号、往返时间、预算、餐段意图、多样性和有审计记录的运营精选计算适合度。来源评分与适合度始终分开。"
        SettingsDocument.SDK -> "第三方服务清单" to
            THIRD_PARTY_SERVICE_DISCLOSURE
        SettingsDocument.HELP -> "使用帮助" to
            "定位失败时可重新点击自动定位，或直接使用手动选址；只授予大致位置也能完成推荐。没有结果时可增加时间、预算或搜索半径，并检查是否排除了过多菜系。弱网或服务暂不可用时可重试，App 不会伪造餐厅结果。账号、授权或数据删除问题请通过问题反馈入口提交，且不要在反馈正文填写验证码、密码或第三方访问凭证。"
        SettingsDocument.CHANGELOG -> "更新日志" to
            "0.1.3 邀请测试版：手机号使用普通短信验证码完成登录或创建账号；微信、QQ、邮箱只登录已绑定身份，登录后再显式绑定。推荐与地点选择继续开放全国范围，并保留游客快速决策、前台定位与手动选址、推荐说明、账号数据权利和隐私撤回。App 不提供运营商免输号码入口、图片挑战或直接餐厅关键词搜索。真实能力仅在服务端配置、合规材料和平台凭据全部满足时开放。"
        SettingsDocument.VERSION -> "版本兼容性检查" to when (
            val status = AppVersionPolicy.evaluate(BuildConfig.VERSION_NAME, minimumSupportedVersion)
        ) {
            is AppVersionStatus.UpdateRequired -> "当前版本 ${BuildConfig.VERSION_NAME} 低于服务端最低版本 ${status.minimumVersion}。请通过原邀请测试渠道获取经验证签名的新 APK；本应用不会从不明链接静默安装更新。"
            is AppVersionStatus.Compatible -> "当前版本 ${BuildConfig.VERSION_NAME} 满足服务端最低兼容版本 ${status.minimumVersion}。这只表示仍可使用，不代表已是最新版本；邀请测试更新请以原测试渠道发布记录为准。"
            AppVersionStatus.ConfigurationUnavailable -> "当前版本 ${BuildConfig.VERSION_NAME}。暂时无法取得服务端最低兼容版本，因此不会声称已是最新版；请以原邀请测试渠道的签名 APK 和哈希为准。"
        }
    }
    AppDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Text(
                text = body,
            )
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

private fun AppVersionStatus.description(): String = when (this) {
    is AppVersionStatus.UpdateRequired -> "当前版本过低，最低需要 $minimumVersion"
    is AppVersionStatus.Compatible -> "满足服务端最低兼容版本 $minimumVersion"
    AppVersionStatus.ConfigurationUnavailable -> "暂时无法取得服务端版本要求"
}
