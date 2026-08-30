package com.chishenme.app.feature.support

import androidx.activity.compose.BackHandler
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.chishenme.app.data.remote.SupportFeedbackCategory
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppEmptyState
import com.chishenme.app.ui.AppHeroCard
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppPrimaryButton
import com.chishenme.app.ui.AppSectionHeader
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone
import com.chishenme.app.ui.AppTopBar

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
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            AppTopBar(
                title = "问题反馈",
                subtitle = "产品建议、纠错与隐私问题",
                onBack = exit,
                navigationEnabled = !state.submitting,
                navigationContentDescription = "返回并清除反馈草稿",
            )
        },
    ) { padding ->
        if (
            !showSupportFeedbackSubmissionControls(
                serverCapabilityEnabled = serverCapabilityEnabled,
                viewModelCapabilityEnabled = state.supportFeedbackEnabled,
            )
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(
                    horizontal = AppDimens.ScreenHorizontal,
                    vertical = AppDimens.ScreenVertical,
                ),
            ) {
                item {
                    AppEmptyState(
                        title = "问题反馈当前未开放",
                        body = "服务端尚未确认反馈服务就绪。本页不会发起提交，请稍后返回设置页重试。",
                        icon = Icons.Rounded.Info,
                    )
                }
            }
        } else {
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
                    eyebrow = "SUPPORT",
                    title = "把问题说清楚",
                    description = "每一条反馈都明确身份边界、处理范围和保留期限。",
                    icon = Icons.Rounded.Info,
                )
            }
            item {
                AppStatusBanner(
                    title = "提交前请注意",
                    body = "请勿填写验证码、密码、第三方访问凭证或精确位置。已登录时反馈会归入当前账号；未登录时按游客提交。登录失效时不会偷偷降级为游客。",
                    tone = AppTone.WARNING,
                    icon = Icons.Rounded.Info,
                )
            }
            if (state.capabilityTransitionBusy) {
                item {
                    AppStatusBanner(
                        title = "正在完成安全切换",
                        body = "上一次提交正在收尾，完成后即可再次提交，不会生成重复工单。",
                        tone = AppTone.INFO,
                        icon = Icons.Rounded.Info,
                    )
                }
            }

            item {
                AppCard {
                    AppSectionHeader(
                        title = "反馈类型",
                        subtitle = "请选择最接近的问题类型",
                    )
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
                                    leadingIcon = if (state.category == category) {
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
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }
            }

            item {
                AppCard {
                    AppSectionHeader(
                        title = "问题详情",
                        subtitle = "正文仅保留在当前页面内存中",
                    )
                    OutlinedTextField(
                        value = state.message,
                        onValueChange = viewModel::updateMessage,
                        label = { Text("请描述问题") },
                        supportingText = {
                            Text("${state.messageLength}/2000 · 至少 10 个字符")
                        },
                        isError = state.message.isNotEmpty() && state.messageLength !in 10..2_000,
                        minLines = 6,
                        maxLines = 12,
                        enabled = !state.submitting,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            state.failureMessage?.let { message ->
                item {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        AppStatusBanner(
                            title = "暂时未能提交",
                            body = message,
                            tone = AppTone.ERROR,
                            icon = Icons.Rounded.Info,
                        )
                        if (state.guestConfirmationRequired) {
                            AppCard {
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
                    AppStatusBanner(
                        title = "反馈已受理 · ${submitted.feedbackId}",
                        body = "工单关闭后将在 ${submitted.retentionAfterClosureDays} 天内删除或匿名化。若服务不可用，请通过原邀请测试渠道联系测试负责人。",
                        tone = AppTone.SUCCESS,
                        icon = AppIcons.ContentCopy,
                    )
                }
            }

            item {
                AppPrimaryButton(
                    text = "提交反馈",
                    onClick = viewModel::submit,
                    enabled = state.canSubmit,
                    content = {
                        if (state.submitting) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "正在提交",
                                modifier = Modifier.semantics {
                                    liveRegion = LiveRegionMode.Polite
                                },
                                fontWeight = FontWeight.Bold,
                            )
                        } else {
                            Text("提交反馈", fontWeight = FontWeight.Bold)
                        }
                    },
                )
                if (state.submitting) {
                    Text(
                        "正在确认服务端受理结果，完成前暂不退出，以避免重复工单。",
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { liveRegion = LiveRegionMode.Polite }
                            .padding(top = 8.dp),
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
