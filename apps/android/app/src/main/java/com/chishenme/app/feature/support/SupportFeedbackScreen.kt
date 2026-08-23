package com.chishenme.app.feature.support

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.chishenme.app.data.remote.SupportFeedbackCategory

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupportFeedbackScreen(
    state: SupportFeedbackUiState,
    serverCapabilityEnabled: Boolean,
    viewModel: SupportFeedbackViewModel,
    onBack: () -> Unit,
) {
    val exit: () -> Unit = {
        if (!state.submitting) {
            viewModel.clearDraft()
            onBack()
        }
    }
    BackHandler(enabled = true, onBack = exit)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("问题反馈") },
                navigationIcon = {
                    IconButton(onClick = exit, enabled = !state.submitting) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回并清除反馈草稿")
                    }
                },
            )
        },
    ) { padding ->
        if (
            !showSupportFeedbackSubmissionControls(
                serverCapabilityEnabled = serverCapabilityEnabled,
                viewModelCapabilityEnabled = state.supportFeedbackEnabled,
            )
        ) {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Card(Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            "问题反馈当前未开放",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "服务端尚未确认反馈服务就绪。本页不会发起提交，请稍后返回设置页重试。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(Icons.Rounded.Info, null, tint = MaterialTheme.colorScheme.primary)
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("提交前请注意", fontWeight = FontWeight.Bold)
                            Text(
                                "请勿填写验证码、密码、第三方访问凭证或精确位置。已登录时反馈会归入当前账号；未登录时按游客提交。登录失效时不会偷偷降级为游客。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            item {
                Text("反馈类型", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    categoryRows.forEach { row ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            row.forEach { category ->
                                FilterChip(
                                    selected = state.category == category,
                                    onClick = { viewModel.updateCategory(category) },
                                    enabled = !state.submitting,
                                    label = { Text(category.displayName()) },
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }
            }

            item {
                OutlinedTextField(
                    value = state.message,
                    onValueChange = viewModel::updateMessage,
                    label = { Text("请描述问题") },
                    supportingText = {
                        Text(
                            "${state.messageLength}/2000 · 至少 10 个字符；正文只保留在当前页面内存中",
                        )
                    },
                    isError = state.message.isNotEmpty() && state.messageLength !in 10..2_000,
                    minLines = 6,
                    maxLines = 12,
                    enabled = !state.submitting,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            state.failureMessage?.let { message ->
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text(message, color = MaterialTheme.colorScheme.error)
                            if (state.guestConfirmationRequired) {
                                Text(
                                    "你可以返回后重新登录，或明确选择以游客身份提交。未经选择不会自动改成游客。",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                OutlinedButton(
                                    onClick = viewModel::confirmGuestSubmission,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Text("明确以游客身份继续")
                                }
                            }
                        }
                    }
                }
            }

            state.submitted?.let { submitted ->
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text("反馈已受理", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            Text("受理编号：${submitted.feedbackId}")
                            Text(
                                "工单关闭后将在 ${submitted.retentionAfterClosureDays} 天内删除或匿名化。若服务不可用，请通过原邀请测试渠道联系测试负责人。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            item {
                Button(
                    onClick = viewModel::submit,
                    enabled = state.canSubmit,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (state.submitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(20.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text("提交反馈")
                    }
                }
                if (state.submitting) {
                    Text(
                        "正在确认服务端受理结果，完成前暂不退出，以避免重复工单。",
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            }
        }
    }
}

private val categoryRows = listOf(
    listOf(SupportFeedbackCategory.PRODUCT, SupportFeedbackCategory.PLACE_CORRECTION),
    listOf(SupportFeedbackCategory.PRIVACY, SupportFeedbackCategory.COMPLAINT),
)

private fun SupportFeedbackCategory.displayName(): String = when (this) {
    SupportFeedbackCategory.PRODUCT -> "产品问题"
    SupportFeedbackCategory.PLACE_CORRECTION -> "餐厅纠错"
    SupportFeedbackCategory.PRIVACY -> "隐私问题"
    SupportFeedbackCategory.COMPLAINT -> "投诉"
}
