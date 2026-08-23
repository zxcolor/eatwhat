package com.chishenme.app.feature.search

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PlaceSearchRequest
import com.chishenme.app.data.remote.PlaceSearchResponse
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.domain.DecisionInput
import com.chishenme.app.ui.AppIcons
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaceSearchScreen(
    state: PlaceSearchUiState,
    decisionInput: DecisionInput,
    onKeywordChanged: (String) -> Unit,
    onOpenNowChanged: (Boolean) -> Unit,
    onUseBudgetChanged: (Boolean) -> Unit,
    onSearch: () -> Unit,
    onRetry: () -> Unit,
    onOpenDetail: (PlaceSearchResult) -> Unit,
    onCancelInFlight: () -> Unit,
    onBack: () -> Unit,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentCancelInFlight = rememberUpdatedState(onCancelInFlight)
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) currentCancelInFlight.value()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            currentCancelInFlight.value()
        }
    }
    BackHandler(onBack = onBack)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("搜索附近餐厅") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回首页")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 10.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Text(
                    "直接查餐厅、菜系或食物；结果保留数据源原始顺序，不是 AI 推荐或适合度排名。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (decisionInput.location == null) {
                item {
                    SearchNotice(
                        text = "请先返回首页自动定位或手动选择地点，再搜索附近餐厅。",
                        warning = true,
                    )
                }
            } else {
                item {
                    Surface(
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        shape = MaterialTheme.shapes.large,
                    ) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(14.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Rounded.LocationOn, contentDescription = null)
                                Spacer(Modifier.width(6.dp))
                                Text(decisionInput.location.label, fontWeight = FontWeight.SemiBold)
                            }
                            Text(
                                "${mealPeriodLabel(decisionInput)} · " +
                                    "${formatRadius(normalizedPlaceSearchRadius(decisionInput.radiusMeters))} 内" +
                                    (decisionInput.budgetMaxYuan?.let { " · 当前预算 $it 元" } ?: " · 不限预算"),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "搜索词和坐标只用于本次请求，不保存。",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            if (decisionInput.radiusMeters != normalizedPlaceSearchRadius(decisionInput.radiusMeters)) {
                                Text(
                                    "当前决策半径为 ${formatRadius(decisionInput.radiusMeters)}；" +
                                        "餐厅搜索按独立接口范围使用 " +
                                        "${formatRadius(normalizedPlaceSearchRadius(decisionInput.radiusMeters))}。",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
            }

            item {
                OutlinedTextField(
                    value = state.keyword,
                    onValueChange = onKeywordChanged,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("餐厅、菜系或食物") },
                    placeholder = { Text("例如：面、粥、川菜") },
                    singleLine = true,
                    isError = state.keywordError != null,
                    supportingText = {
                        Text(state.keywordError ?: "支持 1–80 个字符，中文单字也可以搜索")
                    },
                )
            }

            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("基础筛选", style = MaterialTheme.typography.titleSmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = state.openNow,
                            onClick = { onOpenNowChanged(!state.openNow) },
                            label = { Text("只排除明确打烊") },
                        )
                        if (decisionInput.budgetMaxYuan != null) {
                            FilterChip(
                                selected = state.useCurrentBudget,
                                onClick = { onUseBudgetChanged(!state.useCurrentBudget) },
                                label = { Text("按当前预算") },
                            )
                        }
                    }
                    Text(
                        "价格或营业状态未知时仍会保留，并明确提示你核实。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            item {
                Button(
                    onClick = onSearch,
                    enabled = decisionInput.location != null &&
                        state.keyword.isNotEmpty() &&
                        state.keywordError == null &&
                        state.loadState != PlaceSearchLoadState.Loading,
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                ) {
                    if (state.loadState == PlaceSearchLoadState.Loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                    } else {
                        Icon(AppIcons.Restaurant, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(if (state.loadState == PlaceSearchLoadState.Loading) "正在搜索" else "搜索附近餐厅")
                }
            }

            when (val load = state.loadState) {
                PlaceSearchLoadState.Idle,
                PlaceSearchLoadState.Loading -> Unit
                is PlaceSearchLoadState.OutsidePilot -> item {
                    SearchNotice(text = load.notice, warning = true)
                }
                is PlaceSearchLoadState.Empty -> {
                    item { Text("没有找到符合当前条件的餐厅，请换个关键词或放宽筛选。") }
                    load.response.notice?.let { notice -> item { SearchNotice(notice) } }
                }
                is PlaceSearchLoadState.Failed -> item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SearchNotice(text = load.message, warning = true)
                        OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
                            Text("重试上次搜索")
                        }
                    }
                }
                is PlaceSearchLoadState.Ready -> {
                    item {
                        SearchResultsHeader(load.response)
                    }
                    item {
                        PlaceSearchOrientationMap(load.request, load.response.results)
                    }
                    items(
                        items = load.response.results,
                        key = PlaceSearchResult::resultToken,
                    ) { result ->
                        PlaceSearchResultCard(result = result, onClick = { onOpenDetail(result) })
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchResultsHeader(response: PlaceSearchResponse) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("搜索到 ${response.results.size} 个结果", style = MaterialTheme.typography.titleMedium)
        Text(
            "序号保留数据源原始顺序，硬筛选后可能不连续。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        response.notice?.let { SearchNotice(it) }
    }
}

@Composable
private fun PlaceSearchOrientationMap(
    request: PlaceSearchRequest,
    results: List<PlaceSearchResult>,
) {
    val projection = remember(request, results) {
        PlaceSearchOrientationProjector.project(request.location, request.radiusMeters, results)
    }
    val gridColor = MaterialTheme.colorScheme.outlineVariant
    val pointColor = MaterialTheme.colorScheme.primary
    val originColor = MaterialTheme.colorScheme.tertiary

    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text("大致方位图（非道路导航图）", style = MaterialTheme.typography.titleMedium)
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
        ) {
            BoxWithConstraints(
                modifier = Modifier.fillMaxWidth().height(210.dp).padding(10.dp),
            ) {
                Canvas(
                    modifier = Modifier.fillMaxSize().clearAndSetSemantics {
                        contentDescription = projection.accessibilityDescription()
                    },
                ) {
                    drawLine(
                        color = gridColor,
                        start = Offset(0f, center.y),
                        end = Offset(size.width, center.y),
                    )
                    drawLine(
                        color = gridColor,
                        start = Offset(center.x, 0f),
                        end = Offset(center.x, size.height),
                    )
                    drawCircle(originColor, radius = 7.dp.toPx(), center = center)
                }
                projection.points.forEach { point ->
                    Surface(
                        modifier = Modifier
                            .offset(
                                x = maxWidth * point.xFraction - 14.dp,
                                y = maxHeight * point.yFraction - 14.dp,
                            )
                            .size(28.dp)
                            .clip(CircleShape),
                        color = pointColor,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                        shape = CircleShape,
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(point.rank.toString(), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
        if (projection.skippedCount > 0) {
            Text(
                "${projection.skippedCount} 项因坐标基准不一致或信息异常未绘制，仍可在列表查看。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PlaceSearchResultCard(result: PlaceSearchResult, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.Top) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = CircleShape,
                ) {
                    Text(
                        result.rank.toString(),
                        modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                        fontWeight = FontWeight.Bold,
                    )
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(result.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    result.address?.takeIf(String::isNotBlank)?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            Text(
                listOfNotNull(
                    formatDistance(result.distanceMeters),
                    result.sourceRating?.let { "来源评分 %.1f".format(it) },
                    result.averageCostYuan?.let { "人均约 ${it.roundToInt()} 元" },
                    openStatusLabel(result.openStatus),
                ).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
            )
            if (result.tags.isNotEmpty()) {
                Text(
                    result.tags.take(4).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "来源：${result.sourceLabel} · ${dataModeLabel(result.dataMode)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SearchNotice(text: String, warning: Boolean = false) {
    Surface(
        color = if (warning) MaterialTheme.colorScheme.errorContainer
        else MaterialTheme.colorScheme.tertiaryContainer,
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            if (warning) Icon(Icons.Rounded.Warning, contentDescription = null)
            Text(text, style = MaterialTheme.typography.bodySmall)
        }
    }
}

internal fun dataModeLabel(value: String): String = when (value) {
    "LIVE" -> "实时数据"
    "DEMO" -> "演示数据"
    else -> "其他受控数据模式"
}

private fun openStatusLabel(value: OpenStatus): String = when (value) {
    OpenStatus.OPEN -> "营业中"
    OpenStatus.CLOSED -> "已打烊"
    OpenStatus.UNKNOWN -> "营业待确认"
}

private fun mealPeriodLabel(input: DecisionInput): String = when (input.mealPeriod) {
    com.chishenme.app.data.remote.MealPeriod.BREAKFAST -> "早餐"
    com.chishenme.app.data.remote.MealPeriod.LUNCH -> "午餐"
    com.chishenme.app.data.remote.MealPeriod.DINNER -> "晚餐"
}

private fun formatDistance(value: Int): String = if (value < 1_000) "$value 米" else {
    "%.1f 公里".format(value / 1_000.0)
}

private fun formatRadius(value: Int): String = if (value < 1_000) "$value 米" else {
    "%.1f 公里".format(value / 1_000.0)
}
