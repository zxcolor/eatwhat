package com.chishenme.app.feature.results

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.feature.decision.DecisionUiState
import com.chishenme.app.feature.decision.RecommendationLoadState
import com.chishenme.app.domain.DecisionInput
import com.chishenme.app.ui.AppIcons
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
    "远程配置暂不可用：本次仅展示不含 AI 的规则推荐。为保护数据，餐厅详情、导航、电话、复制地址及推荐事件均已关闭；“换一批”仍可使用。"

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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("这顿就吃它") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回")
                    }
                },
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
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            Spacer(Modifier.height(16.dp))
            Text("正在核对营业、预算和路程…", style = MaterialTheme.typography.titleMedium)
            Text(
                "AI 不可用时会自动回退到规则推荐",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ErrorContent(
    message: String,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.errorContainer,
                modifier = Modifier.size(64.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Warning, null, tint = MaterialTheme.colorScheme.error)
                }
            }
            Spacer(Modifier.height(16.dp))
            Text("这次没决定出来", style = MaterialTheme.typography.headlineMedium)
            Text(message, modifier = Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(22.dp))
            Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("重新尝试") }
            TextButton(onClick = onBack) { Text("返回调整条件") }
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
    onSelect: (RecommendationResult) -> Unit,
    modifier: Modifier = Modifier,
) {
    val results = response.results.take(3)
    if (results.isEmpty()) {
        Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("附近暂时没有可靠结果", style = MaterialTheme.typography.headlineMedium)
                Text(response.notice ?: "试试扩大距离或取消部分排除条件")
                Spacer(Modifier.height(16.dp))
                OutlinedButton(onClick = onReroll) { Text("再试一次") }
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
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "推荐结果",
                        style = MaterialTheme.typography.headlineMedium,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        "主推荐与备选排名不会因本地筛选改变",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onWhy) {
                    Icon(Icons.Rounded.Info, null)
                    Spacer(Modifier.width(4.dp))
                    Text("为什么")
                }
            }
        }

        accessPolicy.persistentNotice?.let { notice ->
            item {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(Icons.Rounded.Warning, contentDescription = null)
                        Text(notice, style = MaterialTheme.typography.bodyMedium)
                    }
                }
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
                onFilterChange = updateFilter,
            )
        }

        if (filteredResults.isEmpty()) {
            item {
                EmptyFilteredResults(
                    onClear = { updateFilter(RecommendationResultsFilterState()) },
                )
            }
        } else if (presentation == ResultsPresentation.LIST) {
            if (primaryResult != null) {
                item {
                    Text(
                        "主推荐",
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.semantics { heading() },
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
                    Text(
                        "主推荐未符合当前筛选；清除筛选即可重新查看。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (alternatives.isNotEmpty()) {
                item {
                    Text(
                        if (primaryResult == null) "符合筛选的备选" else alternativeHeading(alternatives.size + 1),
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.semantics { heading() },
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
                    detailActionsAvailable = accessPolicy.detailActionsAvailable,
                    onSelect = onSelect,
                    onShowList = { presentationName = ResultsPresentation.LIST.name },
                )
            }
        }

        response.notice?.let { notice ->
            item {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Text(notice, modifier = Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        item {
            OutlinedButton(onClick = onReroll, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Icon(Icons.Rounded.Refresh, null)
                Spacer(Modifier.width(8.dp))
                Text("换一批")
            }
            Text(
                "换一批会重新请求；近期反重复由服务端规则统一处理。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp),
            )
            Spacer(Modifier.height(22.dp))
        }
    }
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
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        FilterChip(
            selected = selected == ResultsPresentation.LIST,
            onClick = { onSelected(ResultsPresentation.LIST) },
            label = { Text("列表") },
            modifier = Modifier.weight(1f),
        )
        FilterChip(
            selected = selected == ResultsPresentation.ORIENTATION,
            onClick = { onSelected(ResultsPresentation.ORIENTATION) },
            label = { Text("附近方位图") },
            modifier = Modifier.weight(1f),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResultsLocalFilters(
    filter: RecommendationResultsFilterState,
    budgetMaxYuan: Int?,
    visibleCount: Int,
    totalCount: Int,
    onFilterChange: (RecommendationResultsFilterState) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "本次结果筛选",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            if (filter.isActive) {
                TextButton(onClick = { onFilterChange(RecommendationResultsFilterState()) }) {
                    Text("清除")
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = filter.openNowOnly,
                onClick = { onFilterChange(filter.copy(openNowOnly = !filter.openNowOnly)) },
                label = { Text("仅营业中") },
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
            RecommendationResultsFilter.countSummary(visibleCount, totalCount, filter),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "筛选仅作用于本次最多 3 条结果；未知营业状态不会标成已打烊，未知价格不会标成超预算。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun EmptyFilteredResults(onClear: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
        shape = MaterialTheme.shapes.large,
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("没有符合当前筛选的结果", style = MaterialTheme.typography.titleLarge)
            Text(
                "原来的主推荐和备选仍在本次会话中，清除筛选即可恢复。",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onClear) { Text("一键清除筛选") }
        }
    }
}

@Composable
private fun NearbyOrientationMap(
    context: RecommendationContext,
    results: List<RecommendationResult>,
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
    val mapFill = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.28f)

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            "附近方位图（非道路导航图）",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            "只表示本次起点与结果的大致相对方位；不含道路、入口、实时路况或导航能力。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 2.dp,
        ) {
            BoxWithConstraints(
                modifier = Modifier.fillMaxWidth().height(MAP_HEIGHT).padding(8.dp),
            ) {
                Canvas(
                    modifier = Modifier
                        .matchParentSize()
                        .clearAndSetSemantics {
                            contentDescription = projection.accessibilitySummary()
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

                Surface(
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier
                        .offset(
                            x = maxWidth * CENTER_FRACTION - USER_MARKER_SIZE / 2f,
                            y = maxHeight * CENTER_FRACTION - USER_MARKER_SIZE / 2f,
                        )
                        .size(USER_MARKER_SIZE)
                        .clearAndSetSemantics { },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text("你", fontWeight = FontWeight.Bold)
                    }
                }

                projection.points.forEach { point ->
                    val result = resultsByRank[point.rank] ?: return@forEach
                    val markerSize = if (point.isPrimary) PRIMARY_MARKER_SIZE else ALTERNATIVE_MARKER_SIZE
                    val markerModifier = Modifier
                        .offset(
                            x = maxWidth * point.xFraction - markerSize / 2f,
                            y = maxHeight * point.yFraction - markerSize / 2f,
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
                                contentDescription = point.accessibilityDescription()
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
                                contentDescription = point.accessibilityDescription()
                            },
                        ) {
                            OrientationMarkerLabel(point.rank)
                        }
                    }
                }
            }
        }

        Text(
            "外圈约 " + distanceLabel(projection.scaleMeters) + "；数字表示原推荐排名。",
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
                    Text(if (point.isPrimary) "主推荐" else "备选")
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
                    Text(if (point.isPrimary) "主推荐" else "备选")
                }
            }
        }
        if (projection.skippedCount > 0) {
            Text(
                "有 " + projection.skippedCount +
                    " 条因坐标基准不一致、距离异常或坐标无效而未绘制；列表仍完整可用。",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
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
    val colors = CardDefaults.cardColors(
        containerColor = if (primary) MaterialTheme.colorScheme.primaryContainer
        else MaterialTheme.colorScheme.surface,
    )
    val elevation = CardDefaults.cardElevation(defaultElevation = if (primary) 4.dp else 1.dp)
    if (onClick == null) {
        Card(
            colors = colors,
            elevation = elevation,
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
    result.imageUrl?.let { url ->
        AsyncImage(
            model = url,
            contentDescription = "${result.name}图片，来源：${result.sourceAttribution}",
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxWidth().height(if (primary) 170.dp else 120.dp),
        )
    }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(result.name, style = if (primary) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.titleLarge)
                Text(result.address, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (dataRightsMode == DataRightsMode.LICENSED_ENRICHMENT && result.fitScore != null) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
                    Text(
                        "适合 ${result.fitScore.toInt()}",
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            result.sourceRating?.let {
                Fact(Icons.Rounded.Star, "来源评分 ${oneDecimal(it)}")
            }
            Fact(Icons.Rounded.LocationOn, distanceLabel(result.distanceMeters))
            Fact(AppIcons.AccessTime, "约 ${result.estimatedTravelMinutes.toInt()} 分钟")
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusPill(result.openStatus)
            Text(result.averageCostYuan?.let { "人均约 ${it.toInt()} 元" } ?: "人均暂无可靠信息")
        }

        result.reasons.take(3).forEach { reason ->
            Text("• ${reason.text}", style = MaterialTheme.typography.bodyMedium)
        }

        if (result.aiAssisted) {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.tertiaryContainer,
                contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Icon(Icons.Rounded.Star, contentDescription = null, Modifier.size(17.dp))
                    Text("AI 辅助推荐", style = MaterialTheme.typography.labelLarge)
                }
            }
        }

        result.warnings.firstOrNull()?.let { warning ->
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.Top) {
                Icon(Icons.Rounded.Warning, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                Text(warning, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }

        HorizontalDivider()
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${confidenceLabel(result.confidence)} · ${result.sourceAttribution}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            Text(
                if (detailActionsAvailable) "查看详情" else "仅展示，详情与操作暂不可用",
                color = if (detailActionsAvailable) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun Fact(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, modifier = Modifier.size(17.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(3.dp))
        Text(text, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun StatusPill(status: OpenStatus) {
    val (label, color) = when (status) {
        OpenStatus.OPEN -> "营业中" to MaterialTheme.colorScheme.secondary
        OpenStatus.CLOSED -> "已打烊" to MaterialTheme.colorScheme.error
        OpenStatus.UNKNOWN -> "营业状态待确认" to MaterialTheme.colorScheme.outline
    }
    Surface(shape = CircleShape, color = color.copy(alpha = 0.14f)) {
        Text(label, color = color, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp))
    }
}

@Composable
private fun WhyRecommendationDialog(
    response: RecommendationResponse,
    input: DecisionInput,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Rounded.Info, null) },
        title = { Text("为什么推荐这些") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "本次条件：${input.mealPeriod.displayName()} · " +
                        "${input.budgetMaxYuan?.let { "人均 ${it} 元内" } ?: "预算不限"} · " +
                        "${input.availableMinutes} 分钟 · 最远 ${distanceLabel(input.radiusMeters.toDouble())}",
                    fontWeight = FontWeight.SemiBold,
                )
                if (response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                    Text("系统先过滤明确停业、超距离和超预算结果，再保持数据源返回顺序；当前不进行自有综合评分或排序。")
                    Text("当前为实时展示模式，未取得数据增强授权，因此不展示自有适合度。", color = MaterialTheme.colorScheme.primary)
                } else {
                    Text("系统先过滤明确停业、超距离和超预算结果，再综合路程、时间、餐段、质量信号与多样性排序。")
                    Text("适合度表示“是否适合此刻”，不等于平台来源评分。")
                }
                Text("规则 ${response.ruleVersion} · 提示词 ${response.promptVersion} · 模型 ${response.modelVersion}", style = MaterialTheme.typography.bodySmall)
                if (response.aiFallbackUsed) Text("本次 AI 不可用，已使用确定性规则回退。")
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("知道了") } },
    )
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
