package com.chishenme.app.feature.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
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
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp, vertical = 72.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = "需要更新后继续",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = "服务端已提高最低兼容版本。为避免旧版本误用已变化的接口，远程功能现已暂停。请只从原邀请测试渠道获取经验证签名的新 APK。",
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(28.dp))
            Text(
                text = "版本信息",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(8.dp))
            Text("当前版本：${BuildConfig.VERSION_NAME}")
            Text("最低支持版本：${minimumSupportedVersion ?: "服务端已要求更新"}")
            Spacer(Modifier.height(32.dp))
            Button(
                onClick = onRecheck,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("重新检查")
            }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onWithdrawPrivacy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("撤回隐私同意")
            }
            Spacer(Modifier.height(28.dp))
            Text(
                text = "数据权利",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(8.dp))
            when {
                dataRightsChecking -> Text(
                    "正在核对本机登录状态…",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                showSignedInDataRightsControls(dataRightsChecking, signedInForDataRights) -> {
                    Text(
                        "已检测到本机登录状态。版本限制不会影响本机退出或个人信息删除申请。",
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))
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
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))
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
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            dataRightsMessage?.let { message ->
                Spacer(Modifier.height(8.dp))
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(16.dp))
            Text(
                text = "撤回后会清除本机登录信息并返回隐私说明；不会跳转到第三方下载地址。",
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (confirmDeletion) {
        AlertDialog(
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
