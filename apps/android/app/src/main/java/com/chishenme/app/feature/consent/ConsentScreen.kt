package com.chishenme.app.feature.consent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.chishenme.app.data.local.ConsentDocumentVersions
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppDialog
import com.chishenme.app.ui.AppHeroCard
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppPrimaryButton
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone

internal enum class ConsentDocument { PRIVACY, TERMS, SDK, AI }

@Composable
fun ConsentScreen(
    onAccept: () -> Unit,
    modifier: Modifier = Modifier,
    withdrawalPersistenceFailed: Boolean = false,
    acceptanceState: ConsentAcceptanceState = ConsentAcceptanceState.IDLE,
) {
    var document by remember { mutableStateOf<ConsentDocument?>(null) }
    var showDeclineExplanation by remember { mutableStateOf(false) }

    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .verticalScroll(rememberScrollState())
                .padding(
                    horizontal = AppDimens.ScreenHorizontal,
                    vertical = 20.dp,
                ),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
        ) {
            AppHeroCard(
                eyebrow = "PRIVACY FIRST",
                title = "吃什么",
                description = "少看列表，快做决定。你的地点和偏好只服务于眼前这一顿。",
                icon = AppIcons.Restaurant,
            )

            AppCard {
                Text(
                    "先把边界说清楚",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                ConsentFeature(
                    icon = { Icon(Icons.Rounded.LocationOn, null) },
                    title = "打开应用时发现附近餐厅",
                    body = "同意后请求定位，收集 3.5 km 内最多两页餐厅，与本次用户位置和定位精度一起，按启动时间分别保存到本机 90 天。拒绝定位后仍可手动选址。",
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                ConsentFeature(
                    icon = { Icon(Icons.Rounded.Lock, null) },
                    title = "先同意，后调用",
                    body = "同意前不会调用推荐网络、验证码投递或微信/QQ 登录等可能处理个人信息的第三方能力。",
                )
            }

            AppCard(containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
                Text(
                    "开始使用前",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "请阅读并同意下列文件。核心推荐需要处理你主动提交的地点和条件；手机号、微信和 QQ 登录都不是游客使用的必要条件。",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "文件版本：${ConsentDocumentVersions.DISPLAY}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    TextButton(onClick = { document = ConsentDocument.PRIVACY }) { Text("隐私政策") }
                    TextButton(onClick = { document = ConsentDocument.TERMS }) { Text("用户协议") }
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    TextButton(onClick = { document = ConsentDocument.SDK }) { Text("第三方清单") }
                    TextButton(onClick = { document = ConsentDocument.AI }) { Text("AI 使用说明") }
                }
            }

            if (withdrawalPersistenceFailed) {
                AppStatusBanner(
                    title = "安全存储暂未确认",
                    body = "隐私撤回已在本次运行中立即生效。登录保持关闭；请勿强制结束应用，待存储恢复后再决定是否重新同意。",
                    tone = AppTone.ERROR,
                    icon = Icons.Rounded.Lock,
                )
            }

            if (acceptanceState == ConsentAcceptanceState.FAILED) {
                AppStatusBanner(
                    title = "暂未完成同意",
                    body = "无法确认本机安全存储，推荐和登录仍保持关闭。请稍后重试。",
                    tone = AppTone.ERROR,
                    icon = Icons.Rounded.Lock,
                )
            }
            AppPrimaryButton(
                text = if (acceptanceState == ConsentAcceptanceState.SAVING) "正在保存…" else "同意并继续",
                onClick = onAccept,
                enabled = acceptanceState != ConsentAcceptanceState.SAVING &&
                    acceptanceState != ConsentAcceptanceState.ACCEPTED,
            )
            OutlinedButton(
                onClick = { showDeclineExplanation = true },
                modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
            ) {
                Text("暂不同意")
            }
            Text(
                "你可以随时在设置中撤回同意。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
        }
    }

    document?.let { selected ->
        DocumentDialog(selected, onDismiss = { document = null })
    }
    if (showDeclineExplanation) {
        AppDialog(
            onDismissRequest = { showDeclineExplanation = false },
            title = { Text("你仍然拥有选择权") },
            text = {
                Text("未同意时我们不会初始化推荐服务。你可以继续阅读说明，或稍后再决定；拒绝系统定位权限不会影响手动选址。")
            },
            confirmButton = {
                TextButton(onClick = { showDeclineExplanation = false }) { Text("我知道了") }
            },
        )
    }
}

@Composable
private fun ConsentFeature(
    icon: @Composable () -> Unit,
    title: String,
    body: String,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Surface(
            modifier = Modifier.size(42.dp),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.primaryContainer,
            contentColor = MaterialTheme.colorScheme.primary,
        ) { Box(contentAlignment = Alignment.Center) { icon() } }
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun DocumentDialog(document: ConsentDocument, onDismiss: () -> Unit) {
    val title: String
    val content: String
    when (document) {
        ConsentDocument.PRIVACY -> {
            title = "隐私政策摘要"
            content = "同意本政策并允许定位后，打开应用时会获取当前位置，通过 HTTPS 自有后端查询附近 3.5 km 内最多两页餐厅。已取得餐厅数据存储权，门店资料与本次用户经纬度、坐标系和定位精度（米）一起，按每次启动时间戳命名为独立 JSON 文件，保存于应用私有目录，保留 90 天，到期清理；系统未提供有效精度时记录为空，不推测精度。撤回隐私同意会停止收集并删除这些餐厅与定位记录。用户查询中心不进入行为事件或错误日志，服务端不保存位置记录。高德启用时，后端把单次查询中心转换为 GCJ-02 后提交高德。精确位置被拒绝时保存系统提供的大致位置与精度，范围以该位置为中心；拒绝所有定位权限仍可手动选址。游客无需注册。本页是内部 Alpha 摘要；邀请测试前需提供完整主体、联系方式及权利入口。"
        }
        ConsentDocument.TERMS -> {
            title = "用户协议摘要"
            content = "本产品提供附近餐饮决策辅助。营业时间、价格和餐饮信息可能发生变化，请以商户现场信息为准。过敏、清真、素食等标签只有在可靠来源存在时展示，不构成绝对保证。"
        }
        ConsentDocument.SDK -> {
            title = "第三方服务清单"
            content = THIRD_PARTY_SERVICE_DISCLOSURE
        }
        ConsentDocument.AI -> {
            title = "AI 使用说明"
            content = "千问只用于理解餐段、预算、时间和用户主动选择的偏好，不接收手机号、第三方账号、设备标识或精确坐标。实际使用 AI 理解条件时会明确标识；仅在获授权增强模式下称为 AI 辅助推荐，失败时由确定性规则回退。"
        }
    }
    AppDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Text(
                text = content,
                textAlign = TextAlign.Start,
            )
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
