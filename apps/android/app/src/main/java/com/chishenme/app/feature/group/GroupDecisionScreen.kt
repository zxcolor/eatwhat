package com.chishenme.app.feature.group

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.GroupConstraintAggregation
import com.chishenme.app.data.remote.GroupRecommendationResponse
import com.chishenme.app.data.remote.GroupRecommendationResult
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.domain.GroupCuisinePolicy
import com.chishenme.app.domain.GroupMemberConstraints
import com.chishenme.app.ui.AppBadge
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppPrimaryButton
import com.chishenme.app.ui.AppSectionHeader
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone
import com.chishenme.app.ui.AppTopBar
import com.chishenme.app.ui.currentAppVisualPalette
import kotlin.math.roundToInt

/**
 * Same-device anonymous group flow. Navigation passes no member or location data;
 * all sensitive request state is owned by the activity-scoped in-memory ViewModel.
 */
@Composable
fun GroupDecisionScreen(
    state: GroupDecisionUiState,
    viewModel: GroupDecisionViewModel,
    locationLabel: String,
    onBack: () -> Unit,
) {
    BackHandler(onBack = onBack)
    val palette = currentAppVisualPalette()
    Scaffold(
        containerColor = palette.page,
        topBar = {
            AppTopBar(
                title = "多人一起选",
                subtitle = "同一台手机 · 匿名约束求交",
                onBack = onBack,
            )
        },
    ) { contentPadding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(contentPadding),
            contentPadding = PaddingValues(
                horizontal = AppDimens.ScreenHorizontal,
                vertical = AppDimens.ScreenVertical,
            ),
            verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
        ) {
            item {
                AppStatusBanner(
                    title = "只在当前进程内轮流填写",
                    body = "不创建房间、账号、姓名或成员档案；所有人共用“$locationLabel”作为出发地点。",
                    tone = AppTone.INFO,
                )
            }

            when (state.phase) {
                GroupDecisionPhase.CLOSED -> item {
                    AppStatusBanner(
                        title = "当前不可用",
                        body = state.formError ?: "群组能力未通过当前云端配置校验。",
                        tone = AppTone.WARNING,
                    )
                }
                GroupDecisionPhase.EDITING -> editingItems(state, viewModel)
                GroupDecisionPhase.REVIEW -> reviewItems(state, viewModel)
                GroupDecisionPhase.SUBMITTING -> submittingItems(state)
                GroupDecisionPhase.RESULT -> resultItems(state, viewModel)
                GroupDecisionPhase.FAILED -> failedItems(state, viewModel)
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.editingItems(
    state: GroupDecisionUiState,
    viewModel: GroupDecisionViewModel,
) {
    item {
        AppCard {
            AppSectionHeader(
                title = "参与人数",
                subtitle = "最少 2 人，最多 8 人；减少人数会丢弃末尾尚未提交的输入。",
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = { viewModel.setMemberCount(state.input.members.size - 1) },
                    enabled = state.input.members.size > 2,
                ) {
                    Icon(AppIcons.Remove, contentDescription = "减少一位成员")
                }
                Text(
                    "${state.input.members.size} 人",
                    modifier = Modifier.padding(horizontal = 20.dp),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                IconButton(
                    onClick = { viewModel.setMemberCount(state.input.members.size + 1) },
                    enabled = state.input.members.size < 8,
                ) {
                    Icon(Icons.Rounded.Add, contentDescription = "增加一位成员")
                }
            }
        }
    }

    item {
        AppCard {
            AppSectionHeader(
                title = "共同出行",
                subtitle = "所有成员使用同一出发地点和交通方式。" +
                    (state.recommendationDefaults?.let {
                        "当前服务最远支持 ${it.maximumRadiusMeters} 米；共同距离取所有成员中最小的值。"
                    } ?: ""),
            )
            ChoiceRow(
                options = listOf(
                    TravelMode.WALK to "步行",
                    TravelMode.BIKE to "骑行",
                    TravelMode.TRANSIT to "公共交通",
                ),
                selected = state.input.travelMode,
                onSelected = viewModel::setTravelMode,
            )
        }
    }

    item {
        AppSectionHeader(
            title = "逐位填写",
            subtitle = "只记录第几位，不收集姓名或任何自由文本。",
        )
        LazyRow(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            itemsIndexed(state.input.members) { index, _ ->
                val confirmed = state.confirmedMembers.getOrNull(index) == true
                FilterChip(
                    selected = index == state.activeMemberIndex,
                    onClick = { viewModel.selectMember(index) },
                    label = { Text("第 ${index + 1} 位") },
                    leadingIcon = if (confirmed) {
                        {
                            Icon(
                                Icons.Rounded.Check,
                                contentDescription = "已确认",
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

    val member = state.input.members.getOrNull(state.activeMemberIndex)
    if (member != null) {
        item {
            MemberEditor(
                ordinal = state.activeMemberIndex + 1,
                total = state.input.members.size,
                member = member,
                maximumRadiusMeters = state.recommendationDefaults?.maximumRadiusMeters,
                softPreferencesAvailable = state.softPreferencesAvailable,
                onChange = { viewModel.updateMember(state.activeMemberIndex, it) },
            )
        }
        state.formError?.let { error ->
            item {
                AppStatusBanner(
                    title = "请检查当前输入",
                    body = error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                    tone = AppTone.ERROR,
                )
            }
        }
        item {
            AppPrimaryButton(
                text = "确认第 ${state.activeMemberIndex + 1} 位条件",
                onClick = { viewModel.confirmCurrentMember() },
            )
        }
    }
    if (state.confirmedMembers.isNotEmpty() && state.confirmedMembers.all { it }) {
        item {
            OutlinedButton(
                onClick = { viewModel.review() },
                modifier = Modifier.fillMaxWidth().heightIn(min = AppDimens.PrimaryButtonHeight),
            ) {
                Text("复核共同条件")
            }
        }
    }
}

@Composable
private fun MemberEditor(
    ordinal: Int,
    total: Int,
    member: GroupMemberConstraints,
    maximumRadiusMeters: Int?,
    softPreferencesAvailable: Boolean,
    onChange: (GroupMemberConstraints) -> Unit,
) {
    AppCard {
        Text(
            "第 $ordinal 位 / 共 $total 位",
            modifier = Modifier.semantics { heading() },
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            "请把手机交给这一位成员，全部选项都是固定范围。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        GroupOption(
            title = "人均预算上限",
            options = listOf(
                null to "不限",
                20 to "20 元",
                30 to "30 元",
                50 to "50 元",
                80 to "80 元",
                120 to "120 元",
            ),
            selected = member.budgetMaxYuan,
            onSelected = { onChange(member.copy(budgetMaxYuan = it)) },
        )
        GroupOption(
            title = "可用时间",
            options = listOf(30, 45, 60, 90, 120).map { it to "$it 分钟" },
            selected = member.availableMinutes,
            onSelected = { onChange(member.copy(availableMinutes = it)) },
        )
        GroupOption(
            title = "最远距离",
            options = (listOf(500, 1_000, 1_500, 3_000, 5_000) +
                listOfNotNull(maximumRadiusMeters) + member.radiusMeters)
                .distinct().sorted().map { radius ->
                    radius to when {
                        radius < 1_000 -> "$radius 米"
                        radius % 1_000 == 0 -> "${radius / 1_000} 公里"
                        else -> "${radius / 1_000.0} 公里"
                    }
                },
            selected = member.radiusMeters,
            onSelected = { onChange(member.copy(radiusMeters = it)) },
        )
        if (softPreferencesAvailable) {
            CuisineChoices(
                title = "更想吃",
                selected = member.preferredCuisines,
                onToggle = { cuisine ->
                    val next = member.preferredCuisines.toggle(cuisine)
                    onChange(
                        member.copy(
                            preferredCuisines = next,
                            excludedCuisines = member.excludedCuisines - cuisine,
                        ),
                    )
                },
            )
        }
        CuisineChoices(
            title = "这次不吃",
            selected = member.excludedCuisines,
            onToggle = { cuisine ->
                val next = member.excludedCuisines.toggle(cuisine)
                onChange(
                    member.copy(
                        excludedCuisines = next,
                        preferredCuisines = member.preferredCuisines - cuisine,
                    ),
                )
            },
        )
    }
}

@Composable
private fun <T> GroupOption(
    title: String,
    options: List<Pair<T, String>>,
    selected: T,
    onSelected: (T) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        ChoiceRow(options = options, selected = selected, onSelected = onSelected)
    }
}

@Composable
private fun <T> ChoiceRow(
    options: List<Pair<T, String>>,
    selected: T,
    onSelected: (T) -> Unit,
) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        itemsIndexed(options) { _, option ->
            FilterChip(
                selected = selected == option.first,
                onClick = { onSelected(option.first) },
                label = { Text(option.second) },
            )
        }
    }
}

@Composable
private fun CuisineChoices(
    title: String,
    selected: Set<String>,
    onToggle: (String) -> Unit,
) {
    Column(
        modifier = Modifier.testTag("group-cuisine-$title"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            itemsIndexed(GroupCuisinePolicy.orderedValues) { _, cuisine ->
                FilterChip(
                    selected = cuisine in selected,
                    onClick = { onToggle(cuisine) },
                    label = { Text(cuisine) },
                )
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.reviewItems(
    state: GroupDecisionUiState,
    viewModel: GroupDecisionViewModel,
) {
    state.aggregation?.let { aggregation ->
        item { AggregationCard(aggregation, state.softPreferencesAvailable) }
    }
    state.formError?.let { error ->
        item { AppStatusBanner("无法提交", error, tone = AppTone.ERROR) }
    }
    item {
        AppPrimaryButton(
            text = "按共同条件查找候选",
            onClick = { viewModel.submit() },
        )
    }
    item {
        OutlinedButton(
            onClick = { viewModel.edit() },
            modifier = Modifier.fillMaxWidth().heightIn(min = AppDimens.MinTouchTarget),
        ) {
            Text("返回重新录入")
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.submittingItems(
    state: GroupDecisionUiState,
) {
    state.aggregation?.let { aggregation ->
        item { AggregationCard(aggregation, state.softPreferencesAvailable) }
    }
    item {
        AppCard(
            modifier = Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                stateDescription = "正在按共同条件查找候选"
            },
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("正在按共同条件查找候选")
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.resultItems(
    state: GroupDecisionUiState,
    viewModel: GroupDecisionViewModel,
) {
    val response = state.response
    if (response == null) {
        item { AppStatusBanner("结果不可用", "本次响应已失效，请返回重新录入。", tone = AppTone.ERROR) }
        return
    }
    item { ResultRightsNotice(response) }
    item { AggregationCard(response.aggregation, state.softPreferencesAvailable) }
    if (response.results.isEmpty()) {
        item {
            AppStatusBanner(
                title = "没有找到候选",
                body = "可以按相同共同条件重试，或返回调整成员条件。",
                tone = AppTone.NEUTRAL,
            )
        }
    } else {
        itemsIndexed(response.results) { index, result ->
            GroupResultCard(
                result = result,
                index = index,
                dataRightsMode = response.dataRightsMode,
            )
        }
    }
    response.notice?.takeIf(String::isNotBlank)?.let { notice ->
        item { AppStatusBanner("服务说明", notice, tone = AppTone.NEUTRAL) }
    }
    item {
        AppPrimaryButton(
            text = "按相同共同条件重新请求",
            onClick = { viewModel.retry() },
            modifier = Modifier.testTag("group-action-retry"),
        )
    }
    item {
        OutlinedButton(
            onClick = { viewModel.edit() },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AppDimens.MinTouchTarget)
                .testTag("group-action-edit"),
        ) {
            Text("返回重新录入")
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.failedItems(
    state: GroupDecisionUiState,
    viewModel: GroupDecisionViewModel,
) {
    item {
        AppStatusBanner(
            title = "这次没有查到共同候选",
            body = state.formError ?: "服务暂时不可用，请稍后重试。",
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
            tone = AppTone.ERROR,
        )
    }
    item {
        AppPrimaryButton(
            text = "按相同共同条件重试",
            onClick = { viewModel.retry() },
            modifier = Modifier.testTag("group-action-retry"),
        )
    }
    item {
        OutlinedButton(
            onClick = { viewModel.edit() },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AppDimens.MinTouchTarget)
                .testTag("group-action-edit"),
        ) {
            Text("返回重新录入")
        }
    }
}

@Composable
private fun AggregationCard(
    aggregation: GroupConstraintAggregation,
    softPreferencesAvailable: Boolean,
) {
    AppCard {
        AppSectionHeader(
            title = "共同条件复核",
            subtitle = "服务端会按相同版本重新计算并回显；客户端核对一致后才展示结果。",
        )
        SummaryLine("参与人数", "${aggregation.memberCount} 人")
        SummaryLine(
            "人均预算上限",
            aggregation.effectiveBudgetMaxYuan?.let { "$it 元" } ?: "不限",
        )
        SummaryLine("可用时间", "${aggregation.effectiveAvailableMinutes} 分钟")
        SummaryLine("最远距离", "${aggregation.effectiveRadiusMeters} 米")
        if (softPreferencesAvailable) {
            SummaryLine(
                "共同偏好",
                aggregation.preferredCuisines.takeIf(List<String>::isNotEmpty)?.joinToString("、")
                    ?: "无额外共同偏好",
            )
            if (aggregation.preferredCuisines.isEmpty()) {
                Text(
                    "没有共同偏好仅表示不额外限定菜系，不代表没有可吃的餐厅。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Text(
                "当前数据仅支持共同限制筛选，未收集或提交菜系偏好；结果仍需逐项核实。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        SummaryLine(
            "共同排除",
            aggregation.excludedCuisines.takeIf(List<String>::isNotEmpty)?.joinToString("、") ?: "无",
        )
        Text(
            "聚合规则：${aggregation.version}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ResultRightsNotice(response: GroupRecommendationResponse) {
    val live = response.dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY
    AppStatusBanner(
        title = if (live) "实时展示候选" else "授权数据候选",
        body = if (live) {
            "本次只按共同硬条件收窄，并保持数据源返回顺序；不计算平台匹配分，也不代表任何成员的满意度。"
        } else {
            "本次可使用透明规则排序，但不计算或声称代表任何成员的满意度、公平度。"
        },
        tone = AppTone.INFO,
    )
}

@Composable
private fun GroupResultCard(
    result: GroupRecommendationResult,
    index: Int,
    dataRightsMode: DataRightsMode,
) {
    AppCard(modifier = Modifier.testTag("group-result-card-$index")) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                    if (index == 0) "首个候选" else "其他候选"
                } else {
                    "候选 ${index + 1}"
                },
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold,
            )
            if (result.dataMode == RecommendationDataMode.DEMO) {
                AppBadge("演示数据", tone = AppTone.WARNING)
            }
        }
        Text(
            result.name,
            modifier = Modifier.semantics { heading() },
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
        )
        Text(
            result.address,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            buildString {
                append(formatDistance(result.distanceMeters))
                append(" · 路程约 ${result.estimatedTravelMinutes.roundToInt()} 分钟")
                append(" · 用餐约 ${result.estimatedMealMinutes.roundToInt()} 分钟")
            },
            style = MaterialTheme.typography.bodySmall,
        )
        Text(
            buildString {
                append(openStatusLabel(result.openStatus))
                result.averageCostYuan?.let { append(" · 人均约 ${it.roundToInt()} 元") }
                result.sourceRating?.let { append(" · 来源评分 $it") }
            },
            style = MaterialTheme.typography.bodySmall,
        )
        if (dataRightsMode == DataRightsMode.LICENSED_ENRICHMENT && result.fitScore != null) {
            Text(
                "透明规则匹配分 ${result.fitScore.roundToInt()}（不是成员满意度）",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
            )
        }
        result.reasons.forEach { reason ->
            Text("· ${reason.text}", style = MaterialTheme.typography.bodySmall)
        }
        result.warnings.forEach { warning ->
            AppStatusBanner("请留意", warning, tone = AppTone.WARNING)
        }
        Text(
            if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
                "数据来源：${result.sourceAttribution} · 数据源顺序 ${result.rank}"
            } else {
                "数据来源：${result.sourceAttribution} · 透明规则候选序号 ${result.rank}"
            },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "仅展示本次候选；不提供详情、导航、拨号、收藏、反馈或分享。",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SummaryLine(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(
            value,
            modifier = Modifier.padding(start = 16.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun Set<String>.toggle(value: String): Set<String> =
    if (value in this) this - value else this + value

private fun formatDistance(distanceMeters: Double): String =
    if (distanceMeters >= 1_000) {
        "${"%.1f".format(distanceMeters / 1_000)} 公里"
    } else {
        "${distanceMeters.roundToInt()} 米"
    }

private fun openStatusLabel(status: OpenStatus): String = when (status) {
    OpenStatus.OPEN -> "营业状态：营业中"
    OpenStatus.CLOSED -> "营业状态：已打烊"
    OpenStatus.UNKNOWN -> "营业状态：待核实"
}
