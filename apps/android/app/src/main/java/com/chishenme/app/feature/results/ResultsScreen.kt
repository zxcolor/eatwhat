package com.chishenme.app.feature.results

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
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
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
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

    // Only harmless presentation/filter primitives are saveable. The response,
    // tokens, POI fields and coordinates remain exclusively in the Activity
    // ViewModel and disappear on process death.
    var presentationName by rememberSaveable(response.requestId) {
        mutableStateOf(ResultsPresentation.LIST.name)
    }
    var openNowOnly by rememberSaveable(response.requestId) { mutableStateOf(false) }
    var knownPriceWithinBudgetOnly by rememberSaveable(response.requestId) { mutableStateOf(false) }
    var cuisineTagQuery by rememberSaveable(response.requestId) { mutableStateOf("") }
    val presentation = ResultsPresentation.entries.firstOrNull { it.name == presentationName }
        ?: ResultsPresentation.LIST
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
            ResultsPresentationToggle(
                selected = presentation,
                onSelected = { presentationName = it.name },
            )
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
        } else if (presentation == ResultsPresentation.LIST) {
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
        } else {
            item {
                NearbyOrientationMap(
                    context = context,
                    results = filteredResults,
                    dataRightsMode = response.dataRightsMode,
                    detailActionsAvailable = accessPolicy.detailActionsAvailable,
                    onSelect = onSelect,
                    onShowList = { presentationName = ResultsPresentation.LIST.name },
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
    AppHeroCard(
        modifier = Modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            stateDescription = "推荐完成，找到 $resultCount 个结果"
        },
        eyebrow = "本次已筛出 $resultCount 个选择",
        title = if (liveDisplayOnly) "本次候选" else "推荐结果",
        description = if (liveDisplayOnly) {
            "候选的数据源顺序不会因本地筛选改变"
        } else {
            "主推荐与备选排名不会因本地筛选改变"
        },
        footer = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    modifier = Modifier.weight(1f),
                    color = Color.White.copy(alpha = 0.12f),
                    contentColor = Color.White,
                    shape = CircleShape,
                    border = BorderStroke(1.dp, Color.White.copy(alpha = 0.15f)),
                ) {
                    Text(
                        text = if (liveDisplayOnly) {
                            "$resultCount 个候选 · 保持数据源顺序"
                        } else {
                            "1 个主推 · 最多 2 个备选"
                        },
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                TextButton(
                    onClick = onWhy,
                    colors = ButtonDefaults.textButtonColors(contentColor = Color.White),
                ) {
                    Icon(Icons.Rounded.Info, contentDescription = null)
                    Spacer(Modifier.width(4.dp))
                    Text("为什么")
                }
            }
        },
    )
}

private enum class ResultsPresentation {
    LIST,
    ORIENTATION,
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResultsPresentationToggle(
    selected: ResultsPresentation,
    onSelected: (ResultsPresentation) -> Unit,
) {
    val palette = currentAppVisualPalette()
    AppCard(contentPadding = PaddingValues(7.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ResultsPresentationChip(
                selected = selected == ResultsPresentation.LIST,
                onClick = { onSelected(ResultsPresentation.LIST) },
                label = "列表",
                modifier = Modifier.weight(1f),
                selectedColor = palette.accentSoft,
            )
            ResultsPresentationChip(
                selected = selected == ResultsPresentation.ORIENTATION,
                onClick = { onSelected(ResultsPresentation.ORIENTATION) },
                label = "附近方位图",
                modifier = Modifier.weight(1f),
                selectedColor = palette.accentSoft,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResultsPresentationChip(
    selected: Boolean,
    onClick: () -> Unit,
    label: String,
    selectedColor: Color,
    modifier: Modifier = Modifier,
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, fontWeight = FontWeight.SemiBold) },
        leadingIcon = if (selected) {
            { Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
        } else {
            null
        },
        modifier = modifier.heightIn(min = AppDimens.MinTouchTarget),
        shape = RoundedCornerShape(AppDimens.CompactRadius),
        colors = FilterChipDefaults.filterChipColors(
            containerColor = Color.Transparent,
            labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
            selectedContainerColor = selectedColor,
            selectedLabelColor = MaterialTheme.colorScheme.primary,
        ),
        border = FilterChipDefaults.filterChipBorder(
            enabled = true,
            selected = selected,
            borderColor = Color.Transparent,
            selectedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.58f),
        ),
    )
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
    AppCard {
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

@Composable
private fun NearbyOrientationMap(
    context: RecommendationContext,
    results: List<RecommendationResult>,
    dataRightsMode: DataRightsMode,
    detailActionsAvailable: Boolean,
    onSelect: (RecommendationResult) -> Unit,
    onShowList: () -> Unit,
) {
    val projection = remember(context, results) {
        NearbyOrientationProjector.project(context, results)
    }
    val resultsByRank = remember(results) { results.associateBy(RecommendationResult::rank) }
    val gridColor = MaterialTheme.colorScheme.outlineVariant
    val axisColor = MaterialTheme.colorScheme.outline
    val palette = currentAppVisualPalette()
    val mapFill = palette.blueSoft.copy(alpha = 0.56f)

    AppCard {
        AppSectionHeader(
            title = "附近方位图（非道路导航图）",
            subtitle = "只表示本次起点与结果的大致相对方位；不含道路、入口、实时路况或导航能力。",
        )
        Surface(
            shape = RoundedCornerShape(AppDimens.CardRadius),
            color = palette.cardMuted,
            border = BorderStroke(1.dp, palette.border),
        ) {
            BoxWithConstraints(
                modifier = Modifier.fillMaxWidth().height(MAP_HEIGHT).padding(8.dp),
            ) {
                Canvas(
                    modifier = Modifier
                        .matchParentSize()
                        .clearAndSetSemantics {
                            contentDescription = projection.accessibilitySummary(dataRightsMode)
                        },
                ) {
                    val center = Offset(size.width / 2f, size.height / 2f)
                    val radiusX = size.width * 0.4f
                    val radiusY = size.height * 0.4f
                    val outerBounds = Rect(
                        left = center.x - radiusX,
                        top = center.y - radiusY,
                        right = center.x + radiusX,
                        bottom = center.y + radiusY,
                    )
                    val innerBounds = Rect(
                        left = center.x - radiusX / 2f,
                        top = center.y - radiusY / 2f,
                        right = center.x + radiusX / 2f,
                        bottom = center.y + radiusY / 2f,
                    )
                    drawOval(color = mapFill, topLeft = outerBounds.topLeft, size = outerBounds.size)
                    drawOval(
                        color = gridColor,
                        topLeft = outerBounds.topLeft,
                        size = outerBounds.size,
                        style = Stroke(width = 2.dp.toPx()),
                    )
                    drawOval(
                        color = gridColor,
                        topLeft = innerBounds.topLeft,
                        size = innerBounds.size,
                        style = Stroke(width = 1.dp.toPx()),
                    )
                    drawLine(
                        color = axisColor,
                        start = Offset(center.x, center.y - radiusY),
                        end = Offset(center.x, center.y + radiusY),
                        strokeWidth = 1.dp.toPx(),
                    )
                    drawLine(
                        color = axisColor,
                        start = Offset(center.x - radiusX, center.y),
                        end = Offset(center.x + radiusX, center.y),
                        strokeWidth = 1.dp.toPx(),
                    )
                }

                CompassLabel("北", Modifier.align(Alignment.TopCenter))
                CompassLabel("东", Modifier.align(Alignment.CenterEnd))
                CompassLabel("南", Modifier.align(Alignment.BottomCenter))
                CompassLabel("西", Modifier.align(Alignment.CenterStart))

                val markerScale = LocalDensity.current.fontScale.coerceIn(1f, 1.35f)
                val userMarkerSize = USER_MARKER_SIZE * markerScale
                Surface(
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier
                        .offset(
                            x = maxWidth * CENTER_FRACTION - userMarkerSize / 2f,
                            y = maxHeight * CENTER_FRACTION - userMarkerSize / 2f,
                        )
                        .size(userMarkerSize)
                        .clearAndSetSemantics { },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text("你", fontWeight = FontWeight.Bold)
                    }
                }

                projection.points.forEach { point ->
                    val result = resultsByRank[point.rank] ?: return@forEach
                    val markerSize = (
                        if (point.isPrimary) PRIMARY_MARKER_SIZE else ALTERNATIVE_MARKER_SIZE
                    ) * markerScale
                    val markerX = (maxWidth * point.xFraction - markerSize / 2f)
                        .coerceIn(0.dp, maxWidth - markerSize)
                    val markerY = (maxHeight * point.yFraction - markerSize / 2f)
                        .coerceIn(0.dp, maxHeight - markerSize)
                    val markerModifier = Modifier
                        .offset(
                            x = markerX,
                            y = markerY,
                        )
                        .size(markerSize)
                    val markerColor = if (point.isPrimary) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.tertiary
                    }
                    val markerContentColor = if (point.isPrimary) {
                        MaterialTheme.colorScheme.onPrimary
                    } else {
                        MaterialTheme.colorScheme.onTertiary
                    }
                    if (detailActionsAvailable) {
                        Surface(
                            onClick = { onSelect(result) },
                            shape = CircleShape,
                            color = markerColor,
                            contentColor = markerContentColor,
                            tonalElevation = 5.dp,
                            modifier = markerModifier.semantics(mergeDescendants = true) {
                                contentDescription = point.accessibilityDescription(dataRightsMode)
                                role = Role.Button
                            },
                        ) {
                            OrientationMarkerLabel(point.rank)
                        }
                    } else {
                        Surface(
                            shape = CircleShape,
                            color = markerColor,
                            contentColor = markerContentColor,
                            tonalElevation = 5.dp,
                            modifier = markerModifier.clearAndSetSemantics {
                                contentDescription = point.accessibilityDescription(dataRightsMode)
                            },
                        ) {
                            OrientationMarkerLabel(point.rank)
                        }
                    }
                }
            }
        }

        Text(
            "外圈约 " + distanceLabel(projection.scaleMeters) + if (
                dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY
            ) {
                "；数字表示数据源原始顺序。"
            } else {
                "；数字表示原推荐排名。"
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        projection.points.forEach { point ->
            val result = resultsByRank[point.rank] ?: return@forEach
            if (detailActionsAvailable) {
                TextButton(
                    onClick = { onSelect(result) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        point.rank.toString() + ". " + point.restaurantName + " · " +
                            point.direction.displayName + " · " +
                            orientationDistanceLabel(point.calculatedDistanceMeters),
                        modifier = Modifier.weight(1f),
                    )
                    Text(resultOrderLabel(point, dataRightsMode))
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        point.rank.toString() + ". " + point.restaurantName + " · " +
                            point.direction.displayName + " · " +
                            orientationDistanceLabel(point.calculatedDistanceMeters),
                        modifier = Modifier.weight(1f),
                    )
                    Text(resultOrderLabel(point, dataRightsMode))
                }
            }
        }
        if (projection.skippedCount > 0) {
            AppStatusBanner(
                title = "部分结果未绘制",
                body = "有 " + projection.skippedCount +
                    " 条因坐标基准不一致、距离异常或坐标无效而未绘制；列表仍完整可用。",
                tone = AppTone.WARNING,
                icon = Icons.Rounded.Warning,
            )
        }
        if (projection.points.isEmpty()) {
            OutlinedButton(onClick = onShowList, modifier = Modifier.fillMaxWidth()) {
                Text("切换列表查看全部结果")
            }
        }
    }
}

@Composable
private fun OrientationMarkerLabel(rank: Int) {
    Box(contentAlignment = Alignment.Center) {
        Text(
            rank.toString(),
            fontWeight = FontWeight.Bold,
            modifier = Modifier.clearAndSetSemantics { },
        )
    }
}

internal fun resultOrderLabel(
    point: NearbyOrientationPoint,
    dataRightsMode: DataRightsMode,
): String = if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
    if (point.isPrimary) "首个候选" else "数据源顺序第 ${point.rank} 个"
} else {
    if (point.isPrimary) "主推荐" else "备选"
}

@Composable
private fun CompassLabel(label: String, modifier: Modifier) {
    Text(
        label,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(6.dp).clearAndSetSemantics { },
    )
}

private fun orientationDistanceLabel(meters: Double): String = if (meters < 1_000.0) {
    "约 " + meters.toInt() + " 米"
} else {
    "约 " + oneDecimal(meters / 1_000.0) + " 公里"
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
private const val CENTER_FRACTION = 0.5f
private val MAP_HEIGHT = 340.dp
private val USER_MARKER_SIZE = 42.dp
private val PRIMARY_MARKER_SIZE = 54.dp
private val ALTERNATIVE_MARKER_SIZE = 48.dp

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
    var imageLoaded by remember(result.imageUrl) { mutableStateOf(false) }
    val imageAlpha by animateFloatAsState(
        targetValue = if (imageLoaded) 1f else 0f,
        animationSpec = tween(AppMotion.ContentMillis),
        label = "recommendation image",
    )
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(if (primary) 176.dp else 122.dp)
            .background(
                Brush.linearGradient(
                    colors = listOf(palette.accentSoft, palette.blueSoft),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = AppIcons.Restaurant,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.72f),
            modifier = Modifier.size(if (primary) 52.dp else 42.dp),
        )
        result.imageUrl?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = if (imageLoaded) {
                    "${result.name}图片，来源：${result.sourceAttribution}"
                } else {
                    null
                },
                contentScale = ContentScale.Crop,
                onLoading = { imageLoaded = false },
                onSuccess = { imageLoaded = true },
                onError = { imageLoaded = false },
                modifier = Modifier.matchParentSize().alpha(imageAlpha),
            )
        }
        Surface(
            modifier = Modifier.align(Alignment.TopStart).padding(12.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
            contentColor = MaterialTheme.colorScheme.onSurface,
            shape = CircleShape,
            border = BorderStroke(1.dp, palette.border.copy(alpha = 0.8f)),
        ) {
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
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
        }
    }
    Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(
                    result.name,
                    style = if (primary) {
                        MaterialTheme.typography.headlineSmall
                    } else {
                        MaterialTheme.typography.titleLarge
                    },
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    result.address,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
            if (dataRightsMode == DataRightsMode.LICENSED_ENRICHMENT && result.fitScore != null) {
                AppBadge(text = "适合 ${result.fitScore.toInt()}", tone = AppTone.ACCENT)
            }
        }

        Surface(
            color = palette.cardMuted,
            shape = RoundedCornerShape(AppDimens.CompactRadius),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 9.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                result.sourceRating?.let {
                    Fact(
                        icon = Icons.Rounded.Star,
                        text = "来源评分 ${oneDecimal(it)}",
                        modifier = Modifier.weight(1f),
                    )
                }
                Fact(
                    icon = Icons.Rounded.LocationOn,
                    text = distanceLabel(result.distanceMeters),
                    modifier = Modifier.weight(1f),
                )
                Fact(
                    icon = AppIcons.AccessTime,
                    text = "约 ${result.estimatedTravelMinutes.toInt()} 分钟",
                    modifier = Modifier.weight(1f),
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusPill(result.openStatus)
            AppBadge(
                text = result.averageCostYuan?.let { "人均约 ${it.toInt()} 元" }
                    ?: "人均暂无可靠信息",
                tone = AppTone.NEUTRAL,
            )
        }

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

        HorizontalDivider()
        Text(
            "${confidenceLabel(result.confidence)} · ${result.sourceAttribution}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
            modifier = Modifier.weight(1f),
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
