package com.chishenme.app.feature.saved

import androidx.compose.foundation.horizontalScroll
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.chishenme.app.data.remote.FavoriteGroup
import com.chishenme.app.data.remote.FavoriteRecord
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PersistedPlacePresentation
import com.chishenme.app.data.remote.PersistedPresentationStatus
import com.chishenme.app.data.remote.PrivateFeedbackRecord
import com.chishenme.app.data.remote.PrivateFeedbackType
import com.chishenme.app.data.remote.RecommendationHistoryAction
import com.chishenme.app.data.remote.RecommendationHistoryItem
import com.chishenme.app.ui.AppBadge
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppDialog
import com.chishenme.app.ui.AppEmptyState
import com.chishenme.app.ui.AppHeroCard
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppPrimaryButton
import com.chishenme.app.ui.AppSnackbarHost
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone
import com.chishenme.app.ui.AppTopBar
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private enum class ClearTarget { HISTORY, PRIVATE_FEEDBACK }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SavedResourcesScreen(
    state: SavedResourcesUiState,
    viewModel: SavedResourcesViewModel,
    onBack: () -> Unit,
    onOpenAccount: () -> Unit,
) {
    val snackbar = remember { SnackbarHostState() }
    var clearTarget by remember { mutableStateOf<ClearTarget?>(null) }
    val selectedItemCount = when (state.selectedSection) {
        SavedResourcesSection.FAVORITES -> state.favorites.size
        SavedResourcesSection.HISTORY -> state.history.size
        SavedResourcesSection.PRIVATE_FEEDBACK -> state.privateFeedback.size
    }

    BackHandler(onBack = onBack)
    LaunchedEffect(state.message) {
        state.message?.let {
            snackbar.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            AppTopBar(
                title = "收藏与账号记录",
                subtitle = "跨设备内容与私有操作",
                onBack = onBack,
                navigationContentDescription = "返回设置",
                actions = {
                    IconButton(
                        onClick = viewModel::refresh,
                        enabled = !state.busy && !state.loginRequired && state.enabledSections.isNotEmpty(),
                    ) {
                        Icon(Icons.Rounded.Refresh, contentDescription = "刷新当前账号记录")
                    }
                },
            )
        },
        snackbarHost = { AppSnackbarHost(snackbar) },
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
                    eyebrow = "PRIVATE LIBRARY",
                    title = "只展示当前账号的数据",
                    description = "本机最近决策与账号历史彼此独立，不静默合并或上传；餐厅信息每次按当前授权实时解析。",
                    icon = Icons.Rounded.Lock,
                )
            }

            if (state.loginRequired) {
                item {
                    AppCard {
                        Text(
                            "登录后管理账号记录",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text("游客推荐不受影响；只有主动登录后才会读取跨设备收藏、账号历史和私有反馈。")
                        AppPrimaryButton(text = "前往账号登录", onClick = onOpenAccount)
                        OutlinedButton(onClick = viewModel::retryLogin, modifier = Modifier.fillMaxWidth()) {
                            Text("我已登录，重新检查")
                        }
                    }
                }
            } else if (state.enabledSections.isEmpty()) {
                item {
                    AppStatusBanner(
                        title = "账号记录能力当前未开放",
                        body = "远程配置或数据授权尚未开放账号记录能力。本次不会上传任何餐厅引用。",
                        tone = AppTone.INFO,
                        icon = Icons.Rounded.Info,
                    )
                }
            } else {
                item {
                    AppCard(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp)) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                        SavedResourcesSection.entries.forEach { section ->
                            FilterChip(
                                selected = state.selectedSection == section,
                                onClick = { viewModel.select(section) },
                                enabled = section in state.enabledSections && !state.busy,
                                label = { Text(section.label()) },
                                leadingIcon = if (state.selectedSection == section) {
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
                            )
                        }
                        }
                    }
                }
                if (state.busy) {
                    item {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics {
                                    liveRegion = LiveRegionMode.Polite
                                    stateDescription = "正在读取当前账号记录"
                                }
                                .padding(vertical = 24.dp),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator()
                            Spacer(Modifier.width(10.dp))
                            Text("正在安全读取账号记录…")
                        }
                    }
                }
                state.loadFailureMessage?.let { failure ->
                    item {
                        AppStatusBanner(
                            title = "暂时无法读取这一页",
                            body = "$failure。请点击右上角刷新重试。",
                            tone = AppTone.ERROR,
                            icon = Icons.Rounded.Info,
                        )
                    }
                }
                if (!state.busy && state.loadFailureMessage == null &&
                    state.selectedSection in state.loadedSections
                ) {
                    item {
                        Text(
                            "已载入 $selectedItemCount 条当前分类记录",
                            modifier = Modifier.semantics {
                                liveRegion = LiveRegionMode.Polite
                                stateDescription = "读取完成，共 $selectedItemCount 条记录"
                            },
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                when (state.selectedSection) {
                    SavedResourcesSection.FAVORITES -> {
                        if (!state.busy && state.selectedSection in state.loadedSections &&
                            state.favorites.isEmpty()
                        ) item { EmptyCard("暂无账号收藏") }
                        items(state.favorites) { record ->
                            FavoriteCard(
                                record = record,
                                busy = state.busy,
                                onMove = { viewModel.updateFavoriteGroup(record) },
                                onDelete = { viewModel.deleteFavorite(record) },
                            )
                        }
                    }
                    SavedResourcesSection.HISTORY -> {
                        item {
                            SectionControl(
                                explanation = "仅表示 App 内操作，不代表到店或实际用餐；原始记录保留 90 天。",
                                showClear = state.history.isNotEmpty(),
                                busy = state.busy,
                                onClear = { clearTarget = ClearTarget.HISTORY },
                            )
                        }
                        if (!state.busy && state.selectedSection in state.loadedSections &&
                            state.history.isEmpty()
                        ) item { EmptyCard("暂无账号推荐历史") }
                        items(state.history) { HistoryCard(it) }
                    }
                    SavedResourcesSection.PRIVATE_FEEDBACK -> {
                        item {
                            SectionControl(
                                explanation = "反馈始终仅自己可见，不形成公开餐厅评分。",
                                showClear = state.privateFeedback.isNotEmpty(),
                                busy = state.busy,
                                onClear = { clearTarget = ClearTarget.PRIVATE_FEEDBACK },
                            )
                        }
                        if (!state.busy && state.selectedSection in state.loadedSections &&
                            state.privateFeedback.isEmpty()
                        ) item { EmptyCard("暂无私有反馈") }
                        items(state.privateFeedback) { record ->
                            FeedbackCard(
                                record = record,
                                busy = state.busy,
                                onDelete = { viewModel.deletePrivateFeedback(record) },
                            )
                        }
                    }
                }
                val hasMore = when (state.selectedSection) {
                    SavedResourcesSection.FAVORITES -> state.favoritesNextCursor != null
                    SavedResourcesSection.HISTORY -> state.historyNextCursor != null
                    SavedResourcesSection.PRIVATE_FEEDBACK -> state.feedbackNextCursor != null
                }
                if (hasMore) {
                    item {
                        OutlinedButton(
                            onClick = viewModel::loadMore,
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("加载更多") }
                    }
                }
            }
        }
    }

    clearTarget?.let { target ->
        AppDialog(
            onDismissRequest = { clearTarget = null },
            title = { Text(if (target == ClearTarget.HISTORY) "清空账号历史？" else "清空全部私有反馈？") },
            text = {
                Text(
                    if (target == ClearTarget.HISTORY) {
                        "这只清空服务器账号中的原始推荐操作历史，不影响本机最近决策。"
                    } else {
                        "全部私有反馈将从当前账号删除，此操作不能在 App 内撤销。"
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    clearTarget = null
                    if (target == ClearTarget.HISTORY) viewModel.clearHistory()
                    else viewModel.clearPrivateFeedback()
                }) { Text("确认清空", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { clearTarget = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun FavoriteCard(
    record: FavoriteRecord,
    busy: Boolean,
    onMove: () -> Unit,
    onDelete: () -> Unit,
) {
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AppBadge(
                    if (record.group == FavoriteGroup.WANT_TO_GO) "想去" else "常吃",
                    tone = if (record.group == FavoriteGroup.WANT_TO_GO) AppTone.ACCENT else AppTone.SUCCESS,
                )
                Spacer(Modifier.weight(1f))
                Text(formatAccountTime(record.createdAt), style = MaterialTheme.typography.labelMedium)
            }
            PresentationContent(record.presentation)
            HorizontalDivider()
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onMove, enabled = !busy) {
                    Text(if (record.group == FavoriteGroup.WANT_TO_GO) "移到常吃" else "移到想去")
                }
                TextButton(onClick = onDelete, enabled = !busy) {
                    Icon(Icons.Rounded.Delete, contentDescription = null)
                    Text("删除收藏")
                }
            }
        }
    }
}

@Composable
private fun HistoryCard(item: RecommendationHistoryItem) {
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AppBadge(item.action.label(), tone = AppTone.INFO)
                Spacer(Modifier.weight(1f))
                Text(
                    formatAccountTime(item.occurredAt),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            Text(
                item.mealPeriod.label(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            item.presentation?.let { PresentationContent(it) }
                ?: Text("本操作没有餐厅展示信息", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun FeedbackCard(
    record: PrivateFeedbackRecord,
    busy: Boolean,
    onDelete: () -> Unit,
) {
    AppCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AppBadge(record.type.label(), tone = AppTone.ACCENT)
                Spacer(Modifier.weight(1f))
                Text(formatAccountTime(record.createdAt), style = MaterialTheme.typography.labelMedium)
            }
            record.presentation?.let { PresentationContent(it) }
                ?: Text("本条反馈没有餐厅展示信息", color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onDelete, enabled = !busy) {
                Icon(Icons.Rounded.Delete, contentDescription = null)
                Text("删除这条反馈")
            }
        }
    }
}

@Composable
private fun PresentationContent(presentation: PersistedPlacePresentation) {
    when (presentation.presentationStatus) {
        PersistedPresentationStatus.AVAILABLE -> {
            Text(presentation.name.orEmpty(), style = MaterialTheme.typography.titleMedium)
            presentation.address?.takeIf(String::isNotBlank)?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                listOfNotNull(
                    presentation.openStatus?.label(),
                    presentation.averageCostYuan?.let { "约 ¥${it.toInt()}/人" },
                ).joinToString(" · "),
            )
            presentation.tags.orEmpty().takeIf { it.isNotEmpty() }?.let {
                Text("标签：${it.joinToString(" · ")}", style = MaterialTheme.typography.bodySmall)
            }
            Text(
                "数据来源：${presentation.sourceLabel.orEmpty()}（本次实时解析）",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        PersistedPresentationStatus.TEMPORARILY_UNAVAILABLE -> AppStatusBanner(
            title = "餐厅信息暂不可用",
            body = "餐厅信息暂时无法实时解析，可稍后重试；记录仍可删除。",
            tone = AppTone.NEUTRAL,
            icon = AppIcons.AccessTime,
        )
        PersistedPresentationStatus.RIGHTS_REVOKED -> AppStatusBanner(
            title = "数据授权已撤回",
            body = "数据授权已撤回，餐厅信息不再展示；仅保留可删除的账号记录。",
            tone = AppTone.ERROR,
            icon = Icons.Rounded.Lock,
        )
    }
}

@Composable
private fun SectionControl(
    explanation: String,
    showClear: Boolean,
    busy: Boolean,
    onClear: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            explanation,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (showClear) TextButton(onClick = onClear, enabled = !busy) { Text("清空") }
    }
}

@Composable
private fun EmptyCard(message: String) {
    AppEmptyState(
        title = message,
        body = "这里会展示你主动保存或产生的账号记录。",
        icon = Icons.Rounded.Star,
    )
}

private fun SavedResourcesSection.label() = when (this) {
    SavedResourcesSection.FAVORITES -> "收藏"
    SavedResourcesSection.HISTORY -> "历史"
    SavedResourcesSection.PRIVATE_FEEDBACK -> "私有反馈"
}

internal fun PrivateFeedbackType.label() = when (this) {
    PrivateFeedbackType.WANT_TO_EAT -> "想吃"
    PrivateFeedbackType.ATE -> "吃过"
    PrivateFeedbackType.LIKE -> "喜欢"
    PrivateFeedbackType.DISLIKE -> "不喜欢"
    PrivateFeedbackType.TOO_FAR -> "太远"
    PrivateFeedbackType.TOO_EXPENSIVE -> "太贵"
    PrivateFeedbackType.RECENTLY_ATE -> "最近吃过"
    PrivateFeedbackType.AVOID_CUISINE -> "不想吃这个菜系"
}

private fun RecommendationHistoryAction.label() = when (this) {
    RecommendationHistoryAction.RECOMMENDATION_SHOWN -> "看到了推荐"
    RecommendationHistoryAction.DETAIL_VIEWED -> "查看了详情"
    RecommendationHistoryAction.FAVORITE_ADDED -> "加入了收藏"
    RecommendationHistoryAction.NAVIGATION_OPENED -> "打开了导航"
    RecommendationHistoryAction.PHONE_DIALER_OPENED -> "打开了拨号器"
    RecommendationHistoryAction.REROLL_REQUESTED -> "换了一批推荐"
}

private fun MealPeriod.label() = when (this) {
    MealPeriod.BREAKFAST -> "早餐"
    MealPeriod.LUNCH -> "午餐"
    MealPeriod.DINNER -> "晚餐"
}

private fun OpenStatus.label() = when (this) {
    OpenStatus.OPEN -> "营业中"
    OpenStatus.CLOSED -> "已打烊"
    OpenStatus.UNKNOWN -> "营业状态待确认"
}

private fun formatAccountTime(value: String): String = runCatching {
    ACCOUNT_RECORD_TIME.format(Instant.parse(value))
}.getOrDefault("时间待确认")

private val ACCOUNT_RECORD_TIME = DateTimeFormatter.ofPattern("MM-dd HH:mm")
    .withZone(ZoneId.systemDefault())
