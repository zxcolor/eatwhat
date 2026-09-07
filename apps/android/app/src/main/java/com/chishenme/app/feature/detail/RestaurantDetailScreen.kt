package com.chishenme.app.feature.detail

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.chishenme.app.BuildConfig
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.FavoriteGroup
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationEventType
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.PrivateFeedbackType
import com.chishenme.app.feature.saved.SavedResourcesUiState
import com.chishenme.app.feature.saved.label
import com.chishenme.app.feature.session.ResultSessionState
import com.chishenme.app.ui.AppBadge
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppEmptyState
import com.chishenme.app.ui.AppIconTile
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppMotion
import com.chishenme.app.ui.AppSectionHeader
import com.chishenme.app.ui.AppSnackbarHost
import com.chishenme.app.ui.AppStatusBanner
import com.chishenme.app.ui.AppTone
import com.chishenme.app.ui.AppTopBar
import com.chishenme.app.ui.currentAppVisualPalette
import java.util.Locale
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RestaurantDetailScreen(
    result: RecommendationResult,
    resultSessionState: ResultSessionState,
    resultSessionStateProvider: () -> ResultSessionState,
    persistenceState: SavedResourcesUiState,
    onBack: () -> Unit,
    onEvent: (RecommendationEventType) -> Unit,
    onFavorite: (FavoriteGroup) -> Unit,
    onPrivateFeedback: (PrivateFeedbackType) -> Unit,
    onOpenAccount: () -> Unit,
    onConsumePersistenceMessage: () -> Unit,
) {
    val context = LocalContext.current
    val actionAvailability = RestaurantActionAvailabilityPolicy.evaluate(result, resultSessionState)
    val actionMessages = actionAvailability.pageMessages()
    val resultSessionCurrent = resultSessionState == ResultSessionState.CURRENT
    val uiScope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var shareInProgress by remember(result.resultToken) { mutableStateOf(false) }

    LaunchedEffect(persistenceState.message) {
        persistenceState.message?.let {
            snackbar.showSnackbar(it)
            onConsumePersistenceMessage()
        }
    }

    BackHandler(onBack = onBack)
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            AppTopBar(
                title = "餐厅详情",
                subtitle = "信息、操作与私有记录",
                onBack = onBack,
                navigationContentDescription = "返回推荐结果",
            )
        },
        snackbarHost = { AppSnackbarHost(snackbar) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(
                start = AppDimens.ScreenHorizontal,
                end = AppDimens.ScreenHorizontal,
                top = AppDimens.ScreenVertical,
                bottom = 36.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(AppDimens.SectionGap),
        ) {
            item {
                AppCard(contentPadding = PaddingValues(0.dp)) {
                    RestaurantHeroImage(result)
                    Column(
                        modifier = Modifier.padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            AppIconTile(icon = AppIcons.Restaurant, size = 40.dp)
                            Text(
                                result.name,
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            AppBadge(
                                openStatusLabel(result.openStatus),
                                tone = if (result.openStatus == OpenStatus.OPEN) {
                                    AppTone.SUCCESS
                                } else {
                                    AppTone.NEUTRAL
                                },
                            )
                            result.averageCostYuan?.let {
                                AppBadge("约 ¥${it.toInt()}/人", tone = AppTone.ACCENT)
                            }
                        }
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            DetailFact(
                                icon = Icons.Rounded.LocationOn,
                                text = detailDistanceLabel(result.distanceMeters),
                            )
                            DetailFact(
                                icon = AppIcons.AccessTime,
                                text = "约 ${result.estimatedTravelMinutes.toInt()} 分钟",
                            )
                        }
                        Text(
                            result.address,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "数据来源：${result.sourceAttribution}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            item {
                AppCard {
                    AppSectionHeader(
                        title = "到店操作",
                        subtitle = "仅在当前结果会话和数据授权允许时启用",
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            if (!actionAvailability.navigate.enabled) {
                                return@Button
                            } else if (AndroidRestaurantActions.openNavigation(
                                    context,
                                    result,
                                    resultSessionStateProvider,
                                )
                            ) {
                                onEvent(RecommendationEventType.NAVIGATION)
                            } else {
                                uiScope.launch { snackbar.showSnackbar("没有可用的地图应用") }
                            }
                        },
                        enabled = actionAvailability.navigate.enabled,
                        shape = RoundedCornerShape(AppDimens.CompactRadius),
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = AppDimens.MinTouchTarget)
                            .actionStateDescription(actionAvailability.navigate, "地图查询"),
                    ) {
                        Icon(Icons.Rounded.LocationOn, contentDescription = null)
                        Spacer(Modifier.width(5.dp))
                        Text("地图查询")
                    }
                    OutlinedButton(
                        onClick = {
                            if (!actionAvailability.copyAddress.enabled) {
                                return@OutlinedButton
                            } else {
                                val copied = AndroidRestaurantActions.copyAddress(
                                    context,
                                    result,
                                    resultSessionStateProvider,
                                )
                                uiScope.launch {
                                    snackbar.showSnackbar(if (copied) "地址已复制" else "暂时无法复制地址")
                                }
                            }
                        },
                        enabled = actionAvailability.copyAddress.enabled,
                        shape = RoundedCornerShape(AppDimens.CompactRadius),
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = AppDimens.MinTouchTarget)
                            .actionStateDescription(actionAvailability.copyAddress, "复制地址"),
                    ) {
                        Icon(AppIcons.ContentCopy, contentDescription = null)
                        Spacer(Modifier.width(5.dp))
                        Text("复制地址")
                    }
                    }
                    OutlinedButton(
                        onClick = {
                            if (!actionAvailability.call.enabled) {
                                return@OutlinedButton
                            } else if (AndroidRestaurantActions.dial(
                                    context,
                                    result,
                                    resultSessionStateProvider,
                                )
                            ) {
                                onEvent(RecommendationEventType.CALL)
                            } else {
                                uiScope.launch { snackbar.showSnackbar("没有可用的拨号应用") }
                            }
                        },
                        enabled = actionAvailability.call.enabled,
                        shape = RoundedCornerShape(AppDimens.CompactRadius),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = AppDimens.MinTouchTarget)
                            .actionStateDescription(actionAvailability.call, "联系商户"),
                    ) {
                        Icon(Icons.Rounded.Call, contentDescription = null)
                        Spacer(Modifier.width(7.dp))
                        Text("联系商户")
                    }
                }
            }
            if (actionMessages.isNotEmpty()) {
                item {
                    AppCard(
                        contentPadding = PaddingValues(14.dp),
                        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    ) {
                        Text(
                            "部分操作暂不可用",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        actionMessages.forEach { message ->
                            Text(
                                message,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            item {
                AppCard(containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
                        AppSectionHeader(
                            title = "保存到账号",
                            subtitle = "仅保存 App 自有引用，不保存坐标、电话或外部图片",
                        )
                        Text(
                            "仅在已登录且数据授权允许时保存 App 自有引用；不会保存坐标、电话、外部图片或供应商地点 ID。",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(
                                onClick = {
                                    if (resultSessionStateProvider() == ResultSessionState.CURRENT) {
                                        onFavorite(FavoriteGroup.WANT_TO_GO)
                                    }
                                },
                                enabled = resultSessionCurrent &&
                                    !persistenceState.busy && !persistenceState.favoriteSaved,
                                shape = RoundedCornerShape(AppDimens.CompactRadius),
                                modifier = Modifier.weight(1f).heightIn(min = AppDimens.MinTouchTarget),
                            ) { Text(if (persistenceState.favoriteSaved) "已收藏" else "收藏到想去") }
                            OutlinedButton(
                                onClick = {
                                    if (resultSessionStateProvider() == ResultSessionState.CURRENT) {
                                        onFavorite(FavoriteGroup.REGULAR)
                                    }
                                },
                                enabled = resultSessionCurrent &&
                                    !persistenceState.busy && !persistenceState.favoriteSaved,
                                shape = RoundedCornerShape(AppDimens.CompactRadius),
                                modifier = Modifier.weight(1f).heightIn(min = AppDimens.MinTouchTarget),
                            ) { Text("收藏到常吃") }
                        }
                        if (persistenceState.loginRequired) {
                            TextButton(onClick = onOpenAccount, enabled = !persistenceState.busy) {
                                Text("前往登录账号")
                            }
                        }
                }
            }
            item {
                AppCard {
                    AppSectionHeader(
                        title = "给自己留个反馈",
                        subtitle = "始终私有，不形成公开评分",
                    )
                    Text(
                        "反馈始终私有，不形成公开评分。一次点击只记录所选结构化类型。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    PrivateFeedbackType.entries.chunked(2).forEach { rowTypes ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            rowTypes.forEach { type ->
                                val submitted = type in persistenceState.submittedFeedback
                                OutlinedButton(
                                    onClick = {
                                        if (resultSessionStateProvider() == ResultSessionState.CURRENT) {
                                            onPrivateFeedback(type)
                                        }
                                    },
                                    enabled = resultSessionCurrent && !persistenceState.busy && !submitted,
                                    shape = RoundedCornerShape(AppDimens.CompactRadius),
                                    modifier = Modifier.weight(1f).heightIn(min = AppDimens.MinTouchTarget),
                                ) { Text(if (submitted) "已记录：${type.label()}" else type.label()) }
                            }
                            if (rowTypes.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }
            }
            if (BuildConfig.SHARE_FEATURE_ENABLED) {
                item {
                    OutlinedButton(
                        onClick = {
                            if (!actionAvailability.share.enabled) {
                                return@OutlinedButton
                            }
                            if (shareInProgress) return@OutlinedButton
                            shareInProgress = true
                            uiScope.launch {
                                try {
                                    when (AndroidRestaurantActions.share(
                                        context,
                                        result,
                                        resultSessionStateProvider,
                                    )) {
                                        RestaurantShareOutcome.STARTED -> Unit
                                        RestaurantShareOutcome.NO_TARGET ->
                                            snackbar.showSnackbar("没有可用的分享应用")
                                        RestaurantShareOutcome.GENERATION_FAILED ->
                                            snackbar.showSnackbar("暂时无法生成分享卡，请稍后重试")
                                        RestaurantShareOutcome.NOT_ALLOWED -> Unit
                                    }
                                } finally {
                                    shareInProgress = false
                                }
                            }
                        },
                        enabled = actionAvailability.share.enabled && !shareInProgress,
                        modifier = Modifier
                            .fillMaxWidth()
                            .actionStateDescription(actionAvailability.share, "系统分享"),
                    ) {
                        Icon(Icons.Rounded.Share, contentDescription = null)
                        Spacer(Modifier.width(7.dp))
                        Text(if (shareInProgress) "正在生成分享卡…" else "分享推荐卡")
                    }
                }
            }
            item {
                AppCard {
                    AppSectionHeader(
                        title = "信息与提醒",
                        subtitle = "出发前请再次核实动态信息",
                    )
                    Text("数据来源：${result.sourceAttribution}")
                    Text("数据置信度：${confidenceLabel(result.confidence)}")
                    Text("营业状态：${openStatusLabel(result.openStatus)}")
                    Text(result.averageCostYuan?.let { "参考人均：约 ${it.toInt()} 元" } ?: "参考人均：暂无可靠信息")
                }
            }
            if (result.aiAssisted) {
                item {
                    Notice(
                        icon = Icons.Rounded.Star,
                        text = "本条推荐包含 AI 辅助判断，可能出错，请自行核实。",
                    )
                }
            }
            if (result.dataMode == RecommendationDataMode.DEMO) {
                item {
                    Notice(
                        icon = Icons.Rounded.Warning,
                        text = "这是演示数据，不代表真实商户，请勿据此出行或联系。",
                        isWarning = true,
                    )
                }
            }
            if (result.tags.isNotEmpty()) {
                item {
                    AppCard {
                        AppSectionHeader(title = "标签")
                        Text("标签：${result.tags.joinToString(" · ")}")
                    }
                }
            }
            if (result.warnings.isNotEmpty()) {
                item {
                    AppCard(containerColor = MaterialTheme.colorScheme.errorContainer) {
                        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(
                                "请特别注意",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            result.warnings.forEach { warning ->
                                Text("• $warning", color = MaterialTheme.colorScheme.onErrorContainer)
                            }
                        }
                    }
                }
            }
            item {
                Text(
                    "营业、价格及过敏原信息可能变化，请在出发前向商户确认。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun Notice(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String,
    isWarning: Boolean = false,
) {
    AppStatusBanner(
        title = if (isWarning) "演示数据提醒" else "AI 辅助提醒",
        body = text,
        tone = if (isWarning) AppTone.ERROR else AppTone.INFO,
        icon = icon,
    )
}

@Composable
private fun RestaurantHeroImage(result: RecommendationResult) {
    val imageUrl = result.imageUrl?.takeIf { it.isNotBlank() } ?: return
    var imageFailed by remember(imageUrl) { mutableStateOf(false) }
    if (imageFailed) return
    val palette = currentAppVisualPalette()
    var imageLoaded by remember(imageUrl) { mutableStateOf(false) }
    val imageAlpha by animateFloatAsState(
        targetValue = if (imageLoaded) 1f else 0f,
        animationSpec = tween(AppMotion.ContentMillis),
        label = "restaurant detail image",
    )

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(168.dp)
            .clip(MaterialTheme.shapes.large)
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
            modifier = Modifier.size(52.dp),
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
            modifier = Modifier
                .matchParentSize()
                .alpha(imageAlpha),
        )
    }
}

@Composable
private fun DetailFact(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(17.dp),
            tint = MaterialTheme.colorScheme.primary,
        )
        Text(text, style = MaterialTheme.typography.labelMedium)
    }
}

private fun detailDistanceLabel(meters: Double): String = if (meters < 1_000) {
    "${meters.toInt()} 米"
} else {
    "${String.format(Locale.CHINA, "%.1f", meters / 1_000)} 公里"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailSessionExpiredScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            AppTopBar(
                title = "餐厅详情",
                subtitle = "当前结果会话",
                onBack = onBack,
                navigationContentDescription = "返回推荐结果",
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                AppEmptyState(
                    title = "详情会话已失效",
                    body = "为避免持久保存第三方餐厅数据，请返回结果页重新打开。",
                    icon = Icons.Rounded.Warning,
                    action = { TextButton(onClick = onBack) { Text("返回推荐结果") } },
                )
            }
        }
    }
}

private fun confidenceLabel(confidence: Confidence) = when (confidence) {
    Confidence.HIGH -> "信息较完整"
    Confidence.MEDIUM -> "部分信息待确认"
    Confidence.LOW -> "信息有限，请先确认"
}

private fun openStatusLabel(status: OpenStatus) = when (status) {
    OpenStatus.OPEN -> "营业中"
    OpenStatus.CLOSED -> "已打烊"
    OpenStatus.UNKNOWN -> "待确认"
}

private fun Modifier.actionStateDescription(
    status: RestaurantActionStatus,
    actionLabel: String,
): Modifier = semantics {
    status.disabledStateDescription(actionLabel)?.let { description ->
        stateDescription = description
    }
}
