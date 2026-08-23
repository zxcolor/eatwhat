package com.chishenme.app.feature.detail

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.chishenme.app.ui.AppIcons
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
    val resultSessionCurrent = resultSessionState == ResultSessionState.CURRENT
    val shareScope = rememberCoroutineScope()
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
        topBar = {
            TopAppBar(
                title = { Text("餐厅详情") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回推荐结果")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            result.imageUrl?.let { imageUrl ->
                item {
                    AsyncImage(
                        model = imageUrl,
                        contentDescription = "${result.name}图片，来源：${result.sourceAttribution}",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxWidth().height(210.dp),
                    )
                }
            }
            item {
                Text(result.name, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(result.address, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item {
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
                                Toast.makeText(context, "没有可用的地图应用", Toast.LENGTH_SHORT).show()
                            }
                        },
                        enabled = actionAvailability.navigate.enabled,
                        modifier = Modifier
                            .weight(1f)
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
                                Toast.makeText(
                                    context,
                                    if (copied) "地址已复制" else "暂时无法复制地址",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        enabled = actionAvailability.copyAddress.enabled,
                        modifier = Modifier
                            .weight(1f)
                            .actionStateDescription(actionAvailability.copyAddress, "复制地址"),
                    ) {
                        Icon(AppIcons.ContentCopy, contentDescription = null)
                        Spacer(Modifier.width(5.dp))
                        Text("复制地址")
                    }
                }
            }
            item {
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
                            Toast.makeText(context, "没有可用的拨号应用", Toast.LENGTH_SHORT).show()
                        }
                    },
                    enabled = actionAvailability.call.enabled,
                    modifier = Modifier
                        .fillMaxWidth()
                        .actionStateDescription(actionAvailability.call, "联系商户"),
                ) {
                    Icon(Icons.Rounded.Call, contentDescription = null)
                    Spacer(Modifier.width(7.dp))
                    Text("联系商户")
                }
            }
            item {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    shape = MaterialTheme.shapes.large,
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("保存到账号", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
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
                                modifier = Modifier.weight(1f),
                            ) { Text(if (persistenceState.favoriteSaved) "已收藏" else "收藏到想去") }
                            OutlinedButton(
                                onClick = {
                                    if (resultSessionStateProvider() == ResultSessionState.CURRENT) {
                                        onFavorite(FavoriteGroup.REGULAR)
                                    }
                                },
                                enabled = resultSessionCurrent &&
                                    !persistenceState.busy && !persistenceState.favoriteSaved,
                                modifier = Modifier.weight(1f),
                            ) { Text("收藏到常吃") }
                        }
                        if (persistenceState.loginRequired) {
                            TextButton(onClick = onOpenAccount, enabled = !persistenceState.busy) {
                                Text("前往登录账号")
                            }
                        }
                    }
                }
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Text("给自己留个反馈", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
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
                                    modifier = Modifier.weight(1f),
                                ) { Text(if (submitted) "已记录：${type.label()}" else type.label()) }
                            }
                            if (rowTypes.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }
            }
            val actionMessages = actionAvailability.pageMessages()
            if (actionMessages.isNotEmpty()) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
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
            if (BuildConfig.SHARE_FEATURE_ENABLED) {
                item {
                    OutlinedButton(
                        onClick = {
                            if (!actionAvailability.share.enabled) {
                                return@OutlinedButton
                            }
                            if (shareInProgress) return@OutlinedButton
                            shareInProgress = true
                            shareScope.launch {
                                try {
                                    when (AndroidRestaurantActions.share(
                                        context,
                                        result,
                                        resultSessionStateProvider,
                                    )) {
                                        RestaurantShareOutcome.STARTED -> Unit
                                        RestaurantShareOutcome.NO_TARGET -> Toast.makeText(
                                            context,
                                            "没有可用的分享应用",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                        RestaurantShareOutcome.GENERATION_FAILED -> Toast.makeText(
                                            context,
                                            "暂时无法生成分享卡，请稍后重试",
                                            Toast.LENGTH_SHORT,
                                        ).show()
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
                HorizontalDivider()
                Spacer(Modifier.height(10.dp))
                Text("信息与提醒", style = MaterialTheme.typography.titleMedium)
                Text("数据来源：${result.sourceAttribution}")
                Text("数据置信度：${confidenceLabel(result.confidence)}")
                Text("营业状态：${openStatusLabel(result.openStatus)}")
                Text(result.averageCostYuan?.let { "参考人均：约 ${it.toInt()} 元" } ?: "参考人均：暂无可靠信息")
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
                item { Text("标签：${result.tags.joinToString(" · ")}") }
            }
            if (result.warnings.isNotEmpty()) {
                item {
                    Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium) {
                        Column(Modifier.padding(14.dp)) {
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
    val background = if (isWarning) {
        MaterialTheme.colorScheme.errorContainer
    } else {
        MaterialTheme.colorScheme.tertiaryContainer
    }
    val foreground = if (isWarning) {
        MaterialTheme.colorScheme.onErrorContainer
    } else {
        MaterialTheme.colorScheme.onTertiaryContainer
    }
    Surface(color = background, contentColor = foreground, shape = MaterialTheme.shapes.medium) {
        Row(
            modifier = Modifier.padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(icon, contentDescription = null)
            Text(text)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailSessionExpiredScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("餐厅详情") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回推荐结果")
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Surface(
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Icon(
                        Icons.Rounded.Warning,
                        contentDescription = null,
                        modifier = Modifier.padding(18.dp),
                    )
                }
                Spacer(Modifier.height(16.dp))
                Text("详情会话已失效", style = MaterialTheme.typography.headlineSmall)
                Text(
                    "为避免持久保存第三方餐厅数据，请返回结果页重新打开。",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
                TextButton(onClick = onBack) { Text("返回推荐结果") }
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
