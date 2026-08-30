package com.chishenme.app.feature.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import com.chishenme.app.BuildConfig
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDialog
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppHeroCard
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppPrimaryButton
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone

/** A local-only surface. No remote product navigation remains composed behind it. */
@Composable
fun UpdateRequiredScreen(
    minimumSupportedVersion: String?,
    dataRightsChecking: Boolean,
    signedInForDataRights: Boolean,
    localSessionMaterialPresent: Boolean,
    dataRightsMessage: String?,
    onRecheck: () -> Unit,
    onLocalLogout: () -> Unit,
    onDeleteAccount: () -> Unit,
    onRetryDataRights: () -> Unit,
    onWithdrawPrivacy: () -> Unit,
) {
    var confirmDeletion by remember { mutableStateOf(false) }
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .verticalScroll(rememberScrollState())
                .padding(
                    horizontal = AppDimens.ScreenHorizontal,
                    vertical = 24.dp,
                ),
            horizontalAlignment = Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
        ) {
            AppHeroCard(
                eyebrow = "VERSION GATE",
                title = "需要更新后继续",
                description = "接口已经升级。为了避免旧版本误用变化后的服务，远程功能已安全暂停。",
                icon = AppIcons.AccessTime,
            )

            AppStatusBanner(
                title = "只从原测试渠道更新",
                body = "请获取经验证签名的新 APK。本应用不会跳转到第三方下载地址，也不会静默安装。",
                tone = AppTone.WARNING,
                icon = AppIcons.ContentCopy,
            )

            AppCard {
                Text(
                    text = "版本信息",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text("当前版本：${BuildConfig.VERSION_NAME}")
                Text("最低支持版本：${minimumSupportedVersion ?: "服务端已要求更新"}")
            }

            AppPrimaryButton(text = "重新检查", onClick = onRecheck)
            OutlinedButton(
                onClick = onWithdrawPrivacy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
            ) {
                Text("撤回隐私同意")
            }

            AppCard {
                Text(
                    text = "数据权利",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                when {
                    dataRightsChecking -> AppStatusBanner(
                        title = "正在核对本机登录状态…",
                        body = "检查期间不会恢复被版本门禁暂停的远程产品功能。",
                        tone = AppTone.INFO,
                        icon = AppIcons.AccessTime,
                    )
                    showSignedInDataRightsControls(dataRightsChecking, signedInForDataRights) -> {
                        Text(
                            "已检测到本机登录状态。版本限制不会影响本机退出或个人信息删除申请。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedButton(
                            onClick = onLocalLogout,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("退出本机登录")
                        }
                        OutlinedButton(
                            onClick = { confirmDeletion = true },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("删除个人信息并停用账户")
                        }
                    }
                    showLocalLogoutControl(dataRightsChecking, localSessionMaterialPresent) -> {
                        Text(
                            "检测到本机登录材料，但暂时无法取得有效鉴权。你仍可清除本机登录，或重新核对后再申请删除。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedButton(
                            onClick = onLocalLogout,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("退出本机登录")
                        }
                        OutlinedButton(
                            onClick = onRetryDataRights,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("重新核对删除资格")
                        }
                    }
                    else -> Text(
                        "本机未检测到可管理的登录状态。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                dataRightsMessage?.let { message ->
                    AppStatusBanner(
                        title = "数据权利状态已更新",
                        body = message,
                        tone = AppTone.INFO,
                        icon = AppIcons.ContentCopy,
                    )
                }
            }

            Text(
                text = "撤回后会清除本机登录信息并返回隐私说明；不会跳转到第三方下载地址。",
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            )
            Spacer(Modifier.height(8.dp))
        }
    }

    if (confirmDeletion) {
        AppDialog(
            onDismissRequest = { confirmDeletion = false },
            title = { Text("确认删除个人信息？") },
            text = { Text("提交后账户将立即停用，个人信息按公示期限清理。此操作不可通过旧版本撤销。") },
            dismissButton = {
                OutlinedButton(onClick = { confirmDeletion = false }) { Text("取消") }
            },
            confirmButton = {
                Button(
                    onClick = {
                        confirmDeletion = false
                        onDeleteAccount()
                    },
                ) { Text("确认停用并删除") }
            },
        )
    }
}

internal fun showSignedInDataRightsControls(
    checking: Boolean,
    signedIn: Boolean,
): Boolean = !checking && signedIn

internal fun showLocalLogoutControl(
    checking: Boolean,
    localSessionMaterialPresent: Boolean,
): Boolean = !checking && localSessionMaterialPresent
