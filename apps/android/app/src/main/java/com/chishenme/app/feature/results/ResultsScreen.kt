package com.chishenme.app.feature.results

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationProfileFamily
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.RecommendationTarget
import com.chishenme.app.data.remote.WeatherApplicationKind
import com.chishenme.app.domain.DecisionInput
import com.chishenme.app.feature.decision.DecisionUiState
import com.chishenme.app.feature.decision.RecommendationLoadState
import com.chishenme.app.ui.AppBadge
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppDialog
import com.chishenme.app.ui.AppEmptyState
import com.chishenme.app.ui.AppHeroCard
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppMotion
import com.chishenme.app.ui.AppPrimaryButton
import com.chishenme.app.ui.AppSectionHeader
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone
import com.chishenme.app.ui.AppTopBar
import com.chishenme.app.ui.currentAppVisualPalette
import java.util.Locale

internal data class RecommendationResultsAccessPolicy(
    val detailActionsAvailable: Boolean,
    val persistentNotice: String?,
)

internal fun recommendationResultsAccessPolicy(
    trustedCompatibleConfiguration: Boolean,
): RecommendationResultsAccessPolicy = if (trustedCompatibleConfiguration) {
    RecommendationResultsAccessPolicy(
        detailActionsAvailable = true,
        persistentNotice = null,
    )
} else {
    RecommendationResultsAccessPolicy(
        detailActionsAvailable = false,
        persistentNotice = GUEST_RULES_ONLY_NOTICE,
    )
}

internal const val GUEST_RULES_ONLY_NOTICE =
    "远程配置暂不可用：本次仅展示不含 AI 的规则推荐。为保护数据，餐厅详情、导航、电话、复制地址及推荐事件均已关闭；仍可按相同条件重新请求，结果可能相同。"

internal const val SAME_CONDITIONS_RETRY_DESCRIPTION =
    "按相同条件重新请求，结果可能相同。"
internal const val SAME_CONDITIONS_RETRY_ACTION = "按相同条件重新请求"
internal const val ADJUST_CONDITIONS_ACTION = "返回调整条件"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResultsScreen(
    state: DecisionUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onReroll: () -> Unit,
    onOpenDetail: (RecommendationResult) -> Unit,
) {
    var showWhy by remember { mutableStateOf(false) }
    val readyState = state.loadState as? RecommendationLoadState.Ready
    val activeTarget = readyState?.context?.target ?: state.input.target
    val activeDataRightsMode = readyState?.response?.dataRightsMode

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            AppTopBar(
                title = activeTarget.resultHeadline(activeDataRightsMode),
                subtitle = "最多 3 个符合当前条件的候选",
                onBack = onBack,
            )
        },
    ) { padding ->
        when (val loadState = state.loadState) {
            RecommendationLoadState.Idle -> ErrorContent(
                message = "推荐状态已失效，请返回首页重新选择条件",
                onRetry = onBack,
                onBack = onBack,
                modifier = Modifier.padding(padding),
            )

            RecommendationLoadState.Loading -> LoadingContent(Modifier.padding(padding))

            is RecommendationLoadState.Failed -> ErrorContent(
                message = loadState.message,
                onRetry = onRetry,
                onBack = onBack,
                modifier = Modifier.padding(padding),
            )

            is RecommendationLoadState.Ready -> {
                val accessPolicy = recommendationResultsAccessPolicy(
                    loadState.trustedCompatibleConfiguration,
                )
                ReadyContent(
                    response = loadState.response,
                    context = loadState.context,
                    accessPolicy = accessPolicy,
                    onWhy = { showWhy = true },
                    onReroll = onReroll,
                    onAdjustConditions = onBack,
                    onSelect = onOpenDetail,
                    modifier = Modifier.padding(padding),
                )
            }
        }
    }
    val ready = state.loadState as? RecommendationLoadState.Ready
    if (showWhy && ready != null) {
        WhyRecommendationDialog(
            response = ready.response,
            input = state.input,
            onDismiss = { showWhy = false },
        )
    }
}

@Composable
private fun LoadingContent(modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            horizontal = AppDimens.ScreenHorizontal,
            vertical = AppDimens.ScreenVertical,
        ),
        verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
    ) {
        item {
            AppHeroCard(
                modifier = Modifier.semantics {
                    liveRegion = LiveRegionMode.Polite
                    stateDescription = "正在获取推荐"
                },
                eyebrow = "正在生成本次答案",
                title = "正在核对营业、预算和路程…",
                description = "将按本次目标与所选条件生成候选",
                footer = {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            color = Color.White,
                            strokeWidth = 2.dp,
                        )
                        Text(
                            "正在核对候选信息",
                            color = Color.White.copy(alpha = 0.82f),
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                },
            )
        }
        items(2) {
            ResultLoadingCard()
        }
    }
}

@Composable
private fun ResultLoadingCard() {
    val palette = currentAppVisualPalette()
    AppCard {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(88.dp)
                .background(palette.cardMuted, RoundedCornerShape(AppDimens.CompactRadius)),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth(0.58f)
                .height(18.dp)
                .background(palette.cardMuted, CircleShape),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .height(12.dp)
                .background(palette.cardMuted, CircleShape),
        )
    }
}

@Composable
private fun ErrorContent(
    message: String,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = AppDimens.ScreenHorizontal, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        AppEmptyState(
            title = "这次没决定出来",
            body = message,
            modifier = Modifier.semantics {
                liveRegion = LiveRegionMode.Assertive
                stateDescription = "推荐失败：$message"
            },
            icon = Icons.Rounded.Warning,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                AppPrimaryButton(
                    text = "重新尝试",
                    icon = Icons.Rounded.Refresh,
                    onClick = onRetry,
                )
                TextButton(onClick = onBack) { Text(ADJUST_CONDITIONS_ACTION) }
            }
        }
    }
}

@Composable
private fun ReadyContent(
    response: RecommendationResponse,
    context: RecommendationContext,
    accessPolicy: RecommendationResultsAccessPolicy,
    onWhy: () -> Unit,
    onReroll: () -> Unit,
    onAdjustConditions: () -> Unit,
    onSelect: (RecommendationResult) -> Unit,
    modifier: Modifier = Modifier,
) {
    val results = response.results.take(3)
    if (results.isEmpty()) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = AppDimens.ScreenHorizontal, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            AppEmptyState(
                title = "附近暂时没有符合条件的候选",
                body = response.notice ?: "试试扩大距离或取消部分排除条件",
                modifier = Modifier.semantics {
                    liveRegion = LiveRegionMode.Polite
                    stateDescription = "推荐完成，附近没有符合条件的候选"
                },
                icon = Icons.Rounded.LocationOn,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = SAME_CONDITIONS_RETRY_DESCRIPTION,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(onClick = onReroll) {
                        Text(SAME_CONDITIONS_RETRY_ACTION)
                    }
                    TextButton(onClick = onAdjustConditions) {
                        Text(ADJUST_CONDITIONS_ACTION)
                    }
                }
            }
        }
        return
    }

    // Only harmless filter primitives are saveable. The response,
    // tokens, POI fields and coordinates remain exclusively in the Activity
    // ViewModel and disappear on process death.
    var openNowOnly by rememberSaveable(response.requestId) { mutableStateOf(false) }
    var knownPriceWithinBudgetOnly by rememberSaveable(response.requestId) { mutableStateOf(false) }
    var cuisineTagQuery by rememberSaveable(response.requestId) { mutableStateOf("") }
    val filter = remember(openNowOnly, knownPriceWithinBudgetOnly, cuisineTagQuery) {
        RecommendationResultsFilterState(
            openNowOnly = openNowOnly,
            knownPriceWithinBudgetOnly = knownPriceWithinBudgetOnly,
            cuisineTagQuery = cuisineTagQuery.take(MAX_CUISINE_QUERY_LENGTH),
        )
    }
    val updateFilter: (RecommendationResultsFilterState) -> Unit = { next ->
        openNowOnly = next.openNowOnly
        knownPriceWithinBudgetOnly = next.knownPriceWithinBudgetOnly
        cuisineTagQuery = next.cuisineTagQuery.take(MAX_CUISINE_QUERY_LENGTH)
    }
    val filteredResults = remember(results, context.budgetMaxYuan, filter) {
        RecommendationResultsFilter.apply(results, context.budgetMaxYuan, filter)
    }
    val primaryResult = filteredResults.firstOrNull { it.rank == 1 }
    val alternatives = filteredResults.filterNot { it.rank == 1 }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            horizontal = AppDimens.ScreenHorizontal,
            vertical = AppDimens.ScreenVertical,
        ),
        verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
    ) {
        item {
            ResultsHero(
                resultCount = results.size,
                dataRightsMode = response.dataRightsMode,
                onWhy = onWhy,
            )
        }

        if (
            response.profile.family != RecommendationProfileFamily.MEAL_LEGACY ||
            response.weatherApplication.kind == WeatherApplicationKind.USER_REPORTED
        ) {
            item {
                AppStatusBanner(
                    title = "本次专项配置",
                    body = buildString {
                        append("目标：${context.target.displayName()}；")
                        append("服务端回显 ${response.profile.displayName()}。")
                        if (response.weatherApplication.kind == WeatherApplicationKind.USER_REPORTED) {
                            append("已应用你本次主动选择的体感，不代表读取了天气观测。")
                        }
                    },
                    tone = AppTone.INFO,
                    icon = Icons.Rounded.Info,
                )
            }
        }

        accessPolicy.persistentNotice?.let { notice ->
            item {
                AppStatusBanner(
                    title = "当前为安全展示模式",
                    body = notice,
                    tone = AppTone.WARNING,
                    icon = Icons.Rounded.Warning,
                )
            }
        }

        item {
            ResultsLocalFilters(
                filter = filter,
                budgetMaxYuan = context.budgetMaxYuan,
                visibleCount = filteredResults.size,
                totalCount = results.size,
                dataRightsMode = response.dataRightsMode,
                onFilterChange = updateFilter,
            )
        }

        if (filteredResults.isEmpty()) {
            item {
                EmptyFilteredResults(
                    dataRightsMode = response.dataRightsMode,
                    onClear = { updateFilter(RecommendationResultsFilterState()) },
                )
            }
        } else {
            if (primaryResult != null) {
                item {
                    AppSectionHeader(
                        title = if (response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                            "首个候选"
                        } else {
                            "主推荐"
                        },
                        subtitle = if (
                            response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY
                        ) {
                            "按数据源原始顺序展示"
                        } else {
                            "综合本次条件，先看这个"
                        },
                    )
                }
                item {
                    RecommendationCard(
                        result = primaryResult,
                        dataRightsMode = response.dataRightsMode,
                        primary = true,
                        onClick = if (accessPolicy.detailActionsAvailable) {
                            { onSelect(primaryResult) }
                        } else {
                            null
                        },
                    )
                }
            } else if (filter.isActive) {
                item {
                    AppStatusBanner(
                        title = if (response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                            "首个候选已被本地筛选隐藏"
                        } else {
                            "主推荐已被本地筛选隐藏"
                        },
                        body = if (response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                            "数据源顺序中的首个候选未符合当前筛选；清除筛选即可重新查看。"
                        } else {
                            "主推荐未符合当前筛选；清除筛选即可重新查看。"
                        },
                        tone = AppTone.INFO,
                        icon = Icons.Rounded.Info,
                    )
                }
            }

            if (alternatives.isNotEmpty()) {
                item {
                    AppSectionHeader(
                        title = if (response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                            if (primaryResult != null) "其他候选" else "符合筛选的候选"
                        } else if (primaryResult == null) {
                            "符合筛选的备选"
                        } else {
                            alternativeHeading(alternatives.size + 1)
                        },
                        subtitle = if (
                            response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY
                        ) {
                            "保持数据源原始顺序"
                        } else {
                            "继续按综合结果顺序展示"
                        },
                    )
                }
            }
            items(alternatives, key = RecommendationResult::rank) { result ->
                RecommendationCard(
                    result = result,
                    dataRightsMode = response.dataRightsMode,
                    primary = false,
                    onClick = if (accessPolicy.detailActionsAvailable) {
                        { onSelect(result) }
                    } else {
                        null
                    },
                )
            }
        }

        response.notice?.let { notice ->
            item {
                AppStatusBanner(
                    title = "本次结果说明",
                    body = notice,
                    tone = AppTone.NEUTRAL,
                    icon = Icons.Rounded.Info,
                )
            }
        }

        item {
            AppCard {
                AppSectionHeader(
                    title = "还想看看别的？",
                    subtitle = SAME_CONDITIONS_RETRY_DESCRIPTION,
                )
                AppPrimaryButton(
                    text = SAME_CONDITIONS_RETRY_ACTION,
                    icon = Icons.Rounded.Refresh,
                    onClick = onReroll,
                )
                TextButton(
                    onClick = onAdjustConditions,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(ADJUST_CONDITIONS_ACTION)
                }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun ResultsHero(
    resultCount: Int,
    dataRightsMode: DataRightsMode,
    onWhy: () -> Unit,
) {
    val liveDisplayOnly = dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY
    val palette = currentAppVisualPalette()
    AppCard(
        modifier = Modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            stateDescription = "推荐完成，找到 $resultCount 个结果"
        },
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        containerColor = palette.blueSoft,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = if (liveDisplayOnly) "本次候选" else "推荐结果",
                        modifier = Modifier.semantics { heading() },
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = "本次已筛出 $resultCount 个选择",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onWhy) {
                    Icon(Icons.Rounded.Info, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("为什么")
                }
            }
            Text(
                text = if (liveDisplayOnly) {
                    "$resultCount 个候选 · 保持数据源顺序"
                } else {
                    "1 个主推 · 最多 2 个备选"
                },
                style = MaterialTheme.typography.labelMedium,
                color = palette.blueStrong,
            )
            Text(
                text = if (liveDisplayOnly) {
                    "候选的数据源顺序不会因本地筛选改变"
                } else {
                    "主推荐与备选排名不会因本地筛选改变"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResultsLocalFilters(
    filter: RecommendationResultsFilterState,
    budgetMaxYuan: Int?,
    visibleCount: Int,
    totalCount: Int,
    dataRightsMode: DataRightsMode,
    onFilterChange: (RecommendationResultsFilterState) -> Unit,
) {
    val palette = currentAppVisualPalette()
    AppCard(contentPadding = PaddingValues(12.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            AppSectionHeader(
                title = "本次结果筛选",
                subtitle = RecommendationResultsFilter.countSummary(
                    visibleCount = visibleCount,
                    totalCount = totalCount,
                    filter = filter,
                    dataRightsMode = dataRightsMode,
                ),
                trailing = if (filter.isActive) {
                    {
                        TextButton(onClick = { onFilterChange(RecommendationResultsFilterState()) }) {
                            Text("清除")
                        }
                    }
                } else {
                    null
                },
            )
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                FilterChip(
                    selected = filter.openNowOnly,
                    onClick = { onFilterChange(filter.copy(openNowOnly = !filter.openNowOnly)) },
                    label = { Text("仅营业中") },
                    leadingIcon = if (filter.openNowOnly) {
                        { Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
                    } else {
                        null
                    },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = palette.greenSoft,
                        selectedLabelColor = palette.greenStrong,
                    ),
                )
                FilterChip(
                    selected = filter.knownPriceWithinBudgetOnly,
                    onClick = {
                        onFilterChange(
                            filter.copy(
                                knownPriceWithinBudgetOnly = !filter.knownPriceWithinBudgetOnly,
                            ),
                        )
                    },
                    label = {
                        Text(
                            budgetMaxYuan?.let { "价格已知且不超 $it 元" } ?: "仅价格已知",
                        )
                    },
                    leadingIcon = if (filter.knownPriceWithinBudgetOnly) {
                        { Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
                    } else {
                        null
                    },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = palette.blueSoft,
                        selectedLabelColor = palette.blueStrong,
                    ),
                )
            }
            OutlinedTextField(
                value = filter.cuisineTagQuery,
                onValueChange = { query ->
                    onFilterChange(filter.copy(cuisineTagQuery = query.take(MAX_CUISINE_QUERY_LENGTH)))
                },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = RoundedCornerShape(AppDimens.CompactRadius),
                label = { Text("菜系标签") },
                placeholder = { Text("例如：川菜、面食、咖啡") },
            )
            Text(
                "筛选仅作用于本次最多 3 条结果；未知营业状态不会标成已打烊，未知价格不会标成超预算。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun EmptyFilteredResults(
    dataRightsMode: DataRightsMode,
    onClear: () -> Unit,
) {
    AppEmptyState(
        title = "没有符合当前筛选的结果",
        body = if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
            "原来的候选及数据源顺序仍在本次会话中，清除筛选即可恢复。"
        } else {
            "原来的主推荐和备选仍在本次会话中，清除筛选即可恢复。"
        },
        modifier = Modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            stateDescription = "当前筛选结果为空"
        },
        icon = AppIcons.Tune,
    ) {
        Button(onClick = onClear) { Text("一键清除筛选") }
    }
}

internal fun alternativeHeading(totalResultCount: Int): String {
    val alternativeCount = (totalResultCount - 1).coerceAtLeast(0)
    return if (alternativeCount == 1) {
        "另一个靠谱选择"
    } else {
        "另外 $alternativeCount 个靠谱选择"
    }
}

private const val MAX_CUISINE_QUERY_LENGTH = 30

@Composable
private fun RecommendationCard(
    result: RecommendationResult,
    dataRightsMode: DataRightsMode,
    primary: Boolean,
    onClick: (() -> Unit)?,
) {
    val palette = currentAppVisualPalette()
    val colors = CardDefaults.cardColors(containerColor = palette.card)
    val elevation = CardDefaults.cardElevation(defaultElevation = if (primary) 3.dp else 1.dp)
    val border = BorderStroke(
        width = if (primary) 1.5.dp else 1.dp,
        color = if (primary) {
            MaterialTheme.colorScheme.primary.copy(alpha = 0.32f)
        } else {
            palette.border
        },
    )
    val shape = RoundedCornerShape(AppDimens.CardRadius)
    if (onClick == null) {
        Card(
            colors = colors,
            elevation = elevation,
            border = border,
            shape = shape,
            modifier = Modifier.fillMaxWidth(),
        ) {
            RecommendationCardBody(
                result = result,
                dataRightsMode = dataRightsMode,
                primary = primary,
                detailActionsAvailable = false,
            )
        }
    } else {
        Card(
            onClick = onClick,
            colors = colors,
            elevation = elevation,
            border = border,
            shape = shape,
            modifier = Modifier.fillMaxWidth(),
        ) {
            RecommendationCardBody(
                result = result,
                dataRightsMode = dataRightsMode,
                primary = primary,
                detailActionsAvailable = true,
            )
        }
    }
}

@Composable
private fun RecommendationCardBody(
    result: RecommendationResult,
    dataRightsMode: DataRightsMode,
    primary: Boolean,
    detailActionsAvailable: Boolean,
) {
    val palette = currentAppVisualPalette()
    val imageUrl = result.imageUrl?.takeIf { it.isNotBlank() }
    var imageLoaded by remember(imageUrl) { mutableStateOf(false) }
    var imageFailed by remember(imageUrl) { mutableStateOf(false) }
    val imageAlpha by animateFloatAsState(
        targetValue = if (imageLoaded) 1f else 0f,
        animationSpec = tween(AppMotion.ContentMillis),
        label = "recommendation image",
    )
    if (imageUrl != null && !imageFailed) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (primary) 156.dp else 116.dp)
                .background(
                    Brush.linearGradient(
                        colors = listOf(palette.accentSoft, palette.cardMuted),
                    ),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = AppIcons.Restaurant,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.72f),
                modifier = Modifier.size(36.dp),
            )
            AsyncImage(
                model = imageUrl,
                contentDescription = if (imageLoaded) {
                    "${result.name}图片，来源：${result.sourceAttribution}"
                } else {
                    null
                },
                contentScale = ContentScale.Crop,
                onLoading = { imageLoaded = false },
                onSuccess = { imageLoaded = true },
                onError = {
                    imageLoaded = false
                    imageFailed = true
                },
                modifier = Modifier.matchParentSize().alpha(imageAlpha),
            )
        }
    }
    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.accentSoft, RoundedCornerShape(AppDimens.CompactRadius))
                .padding(horizontal = 10.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                AppIcons.Restaurant,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                    if (primary) {
                        "首个候选 · 数据源顺序第 1 个"
                    } else {
                        "其他候选 · 数据源顺序第 ${result.rank} 个"
                    }
                } else if (primary) {
                    "主推荐 · 第 1 名"
                } else {
                    "备选 · 第 ${result.rank} 名"
                },
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
        Text(
            result.name,
            style = if (primary) {
                MaterialTheme.typography.headlineSmall
            } else {
                MaterialTheme.typography.titleLarge
            },
            fontWeight = FontWeight.Bold,
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = result.averageCostYuan?.let { "人均约 ${it.toInt()} 元" }
                    ?: "人均暂无可靠信息",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(vertical = 3.dp),
            )
            StatusPill(result.openStatus)
            if (dataRightsMode == DataRightsMode.LICENSED_ENRICHMENT && result.fitScore != null) {
                AppBadge(text = "适合 ${result.fitScore.toInt()}", tone = AppTone.ACCENT)
            }
        }

        Surface(
            color = palette.cardMuted,
            shape = RoundedCornerShape(AppDimens.CompactRadius),
        ) {
            FlowRow(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 9.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                result.sourceRating?.let {
                    Fact(
                        icon = Icons.Rounded.Star,
                        text = "来源评分 ${oneDecimal(it)}",
                    )
                }
                Fact(
                    icon = Icons.Rounded.LocationOn,
                    text = distanceLabel(result.distanceMeters),
                )
                Fact(
                    icon = AppIcons.AccessTime,
                    text = "约 ${result.estimatedTravelMinutes.toInt()} 分钟",
                )
            }
        }

        Text(
            result.address,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "${confidenceLabel(result.confidence)} · ${result.sourceAttribution}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(color = palette.border)

        result.reasons.take(3).forEachIndexed { index, reason ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Surface(
                    color = palette.accentSoft,
                    contentColor = MaterialTheme.colorScheme.primary,
                    shape = CircleShape,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = (index + 1).toString(),
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Text(reason.text, style = MaterialTheme.typography.bodyMedium)
            }
        }

        if (result.aiAssisted) {
            AppBadge(text = aiAssistanceLabel(dataRightsMode), tone = AppTone.SUCCESS)
        }

        result.warnings.firstOrNull()?.let { warning ->
            AppStatusBanner(
                title = "请先确认",
                body = warning,
                tone = AppTone.WARNING,
                icon = Icons.Rounded.Warning,
            )
        }

        HorizontalDivider(color = palette.border)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                if (detailActionsAvailable) {
                    "点击卡片查看完整信息"
                } else {
                    "当前结果仍可用于本次参考"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                if (detailActionsAvailable) "查看详情" else "仅展示，详情与操作暂不可用",
                color = if (detailActionsAvailable) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.align(Alignment.End),
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun Fact(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String,
    modifier: Modifier = Modifier,
) {
    Row(modifier = modifier, verticalAlignment = Alignment.Top) {
        Icon(icon, null, modifier = Modifier.size(17.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(3.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun StatusPill(status: OpenStatus) {
    val (label, tone) = when (status) {
        OpenStatus.OPEN -> "营业中" to AppTone.SUCCESS
        OpenStatus.CLOSED -> "已打烊" to AppTone.ERROR
        OpenStatus.UNKNOWN -> "营业状态待确认" to AppTone.NEUTRAL
    }
    AppBadge(text = label, tone = tone)
}

@Composable
private fun WhyRecommendationDialog(
    response: RecommendationResponse,
    input: DecisionInput,
    onDismiss: () -> Unit,
) {
    AppDialog(
        onDismissRequest = onDismiss,
        icon = {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            ) {
                Icon(
                    Icons.Rounded.Info,
                    contentDescription = null,
                    modifier = Modifier.padding(12.dp),
                )
            }
        },
        title = {
            Text(
                if (response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                    "为什么显示这些候选"
                } else {
                    "为什么推荐这些"
                },
            )
        },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    shape = RoundedCornerShape(AppDimens.CompactRadius),
                ) {
                    Text(
                        "本次条件：${input.mealPeriod.displayName()} · " +
                            "${input.budgetMaxYuan?.let { "人均 ${it} 元内" } ?: "预算不限"} · " +
                            "${input.availableMinutes} 分钟 · 最远 ${distanceLabel(input.radiusMeters.toDouble())}",
                        modifier = Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                if (response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                    Text(
                        "系统先过滤明确停业、超距离和超预算结果，再保持数据源返回顺序；当前不进行自有综合评分或排序。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        "当前为实时展示模式，未取得数据增强授权，因此不展示自有适合度。",
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else {
                    Text(
                        "系统先过滤明确停业、超距离和超预算结果，再综合路程、时间、餐段、质量信号与多样性排序。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        "适合度表示“是否适合此刻”，不等于平台来源评分。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Text(
                    "规则 ${response.ruleVersion} · 提示词 ${response.promptVersion} · 模型 ${response.modelVersion}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "专项 ${response.profile.displayName()} · 目标 ${response.profile.target.displayName()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (response.weatherApplication.kind == WeatherApplicationKind.USER_REPORTED) {
                    Text(
                        "手动体感已用于本次查询；应用未读取实时天气、温度或后台位置。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (response.aiFallbackUsed) {
                    Text(
                        "本次 AI 不可用，已使用确定性规则回退。",
                        style = MaterialTheme.typography.bodySmall,
                        color = currentAppVisualPalette().amberStrong,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("知道了") } },
    )
}

internal fun RecommendationTarget?.resultHeadline(dataRightsMode: DataRightsMode?): String =
    if (dataRightsMode == DataRightsMode.LICENSED_ENRICHMENT) {
        when (this) {
            RecommendationTarget.MILK_TEA -> "这杯奶茶就选它"
            RecommendationTarget.COFFEE -> "这杯咖啡就选它"
            RecommendationTarget.DESSERT -> "这份甜品就选它"
            RecommendationTarget.MEAL,
            null,
            -> "这顿就吃它"
        }
    } else {
        when (this) {
            RecommendationTarget.MILK_TEA -> "本次奶茶候选"
            RecommendationTarget.COFFEE -> "本次咖啡候选"
            RecommendationTarget.DESSERT -> "本次甜品候选"
            RecommendationTarget.MEAL,
            null,
            -> "本次用餐候选"
        }
    }

internal fun aiAssistanceLabel(dataRightsMode: DataRightsMode): String =
    if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
        "AI 辅助理解条件"
    } else {
        "AI 辅助推荐"
    }

private fun RecommendationTarget.displayName(): String = when (this) {
    RecommendationTarget.MEAL -> "普通用餐"
    RecommendationTarget.MILK_TEA -> "奶茶"
    RecommendationTarget.COFFEE -> "咖啡"
    RecommendationTarget.DESSERT -> "甜品"
}

private fun com.chishenme.app.data.remote.RecommendationProfile.displayName(): String =
    when (family) {
        RecommendationProfileFamily.MEAL_LEGACY -> "兼容用餐规则 $version"
        RecommendationProfileFamily.MEAL_BREAKFAST -> "早餐专项 $version"
        RecommendationProfileFamily.MEAL_LUNCH -> "午餐专项 $version"
        RecommendationProfileFamily.MEAL_DINNER -> "晚餐专项 $version"
        RecommendationProfileFamily.MILK_TEA -> "奶茶专项 $version"
        RecommendationProfileFamily.COFFEE -> "咖啡专项 $version"
        RecommendationProfileFamily.DESSERT -> "甜品专项 $version"
    }

private fun com.chishenme.app.data.remote.MealPeriod.displayName() = when (this) {
    com.chishenme.app.data.remote.MealPeriod.BREAKFAST -> "早餐"
    com.chishenme.app.data.remote.MealPeriod.LUNCH -> "午餐"
    com.chishenme.app.data.remote.MealPeriod.DINNER -> "晚餐"
}

private fun distanceLabel(meters: Double): String = if (meters < 1_000) {
    "${meters.toInt()} 米"
} else {
    "${oneDecimal(meters / 1_000)} 公里"
}

private fun oneDecimal(value: Double): String = String.format(Locale.CHINA, "%.1f", value)

private fun confidenceLabel(confidence: Confidence) = when (confidence) {
    Confidence.HIGH -> "信息较完整"
    Confidence.MEDIUM -> "部分信息待确认"
    Confidence.LOW -> "信息有限，请先确认"
}
