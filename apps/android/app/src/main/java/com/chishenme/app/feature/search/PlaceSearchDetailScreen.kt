package com.chishenme.app.feature.search

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.chishenme.app.BuildConfig
import com.chishenme.app.data.remote.FavoriteGroup
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PlaceSearchResponse
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.data.remote.PrivateFeedbackType
import com.chishenme.app.feature.detail.AndroidRestaurantActions
import com.chishenme.app.feature.detail.RestaurantActionAvailabilityPolicy
import com.chishenme.app.feature.detail.RestaurantActionStatus
import com.chishenme.app.feature.detail.toRestaurantDisplayModel
import com.chishenme.app.feature.saved.PersistenceActionGate
import com.chishenme.app.feature.saved.PersistenceCreation
import com.chishenme.app.feature.saved.PersistenceGateDecision
import com.chishenme.app.feature.saved.SavedResourcesUiState
import com.chishenme.app.feature.saved.label
import com.chishenme.app.feature.session.ResultSessionState
import com.chishenme.app.ui.AppIcons
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaceSearchDetailScreen(
    response: PlaceSearchResponse,
    result: PlaceSearchResult,
    resultSessionState: ResultSessionState,
    resultSessionStateProvider: () -> ResultSessionState,
    featureConfig: FeatureConfig?,
    persistenceState: SavedResourcesUiState,
    onBack: () -> Unit,
    onFavorite: (FavoriteGroup) -> Unit,
    onPrivateFeedback: (PrivateFeedbackType) -> Unit,
    onOpenAccount: () -> Unit,
    onConsumePersistenceMessage: () -> Unit,
) {
    val context = LocalContext.current
    val display = remember(result) { result.toRestaurantDisplayModel() }
    val actions = remember(display, resultSessionState) {
        RestaurantActionAvailabilityPolicy.evaluate(display, resultSessionState)
    }
    val resultSessionCurrent = resultSessionState == ResultSessionState.CURRENT
    val favoriteGate = remember(featureConfig, response, result) {
        PersistenceActionGate.evaluate(
            featureConfig,
            response,
            result,
            PersistenceCreation.FAVORITE,
        )
    }
    val feedbackGate = remember(featureConfig, response, result) {
        PersistenceActionGate.evaluate(
            featureConfig,
            response,
            result,
            PersistenceCreation.PRIVATE_FEEDBACK,
        )
    }
    val snackbar = remember { SnackbarHostState() }

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
                title = { Text("搜索结果详情") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回搜索结果")
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
            item {
                Text(result.name, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(
                    result.address?.takeIf(String::isNotBlank) ?: "暂无可靠地址",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "这是关键词搜索结果，不代表 App 推荐或适合度判断。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            if (!AndroidRestaurantActions.openNavigation(
                                    context,
                                    display,
                                    resultSessionStateProvider,
                                )
                            ) {
                                Toast.makeText(context, "没有可用的地图应用", Toast.LENGTH_SHORT).show()
                            }
                        },
                        enabled = actions.navigate.enabled,
                        modifier = Modifier.weight(1f).actionState(actions.navigate, "地图查询"),
                    ) {
                        Icon(Icons.Rounded.LocationOn, contentDescription = null)
                        Spacer(Modifier.width(5.dp))
                        Text("地图查询")
                    }
                    OutlinedButton(
                        onClick = {
                            val copied = AndroidRestaurantActions.copyAddress(
                                context,
                                display,
                                resultSessionStateProvider,
                            )
                            Toast.makeText(
                                context,
                                if (copied) "地址已复制" else "暂时无法复制地址",
                                Toast.LENGTH_SHORT,
                            ).show()
                        },
                        enabled = actions.copyAddress.enabled,
                        modifier = Modifier.weight(1f).actionState(actions.copyAddress, "复制地址"),
                    ) {
                        Icon(AppIcons.ContentCopy, contentDescription = null)
                        Spacer(Modifier.width(5.dp))
                        Text("复制地址")
                    }
                }
            }

            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = {
                            AndroidRestaurantActions.dial(context, display, resultSessionStateProvider)
                        },
                        enabled = actions.call.enabled,
                        modifier = Modifier.weight(1f).actionState(actions.call, "联系商户"),
                    ) {
                        Icon(Icons.Rounded.Call, contentDescription = null)
                        Spacer(Modifier.width(5.dp))
                        Text("联系商户")
                    }
                    if (BuildConfig.SHARE_FEATURE_ENABLED) {
                        OutlinedButton(
                            onClick = {
                                if (!AndroidRestaurantActions.shareText(
                                        context,
                                        display,
                                        resultSessionStateProvider,
                                    )
                                ) {
                                    Toast.makeText(context, "没有可用的分享应用", Toast.LENGTH_SHORT).show()
                                }
                            },
                            enabled = actions.share.enabled,
                            modifier = Modifier.weight(1f).actionState(actions.share, "分享信息"),
                        ) {
                            Icon(Icons.Rounded.Share, contentDescription = null)
                            Spacer(Modifier.width(5.dp))
                            Text("分享信息")
                        }
                    }
                }
            }

            val actionMessages = actions.pageMessages()
            if (actionMessages.isNotEmpty()) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        actionMessages.forEach {
                            Text(
                                it,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            item {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
                    shape = MaterialTheme.shapes.large,
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Text("商户信息", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text("距离：${formatDetailDistance(result.distanceMeters)}")
                        Text("营业状态：${detailOpenStatus(result.openStatus)}")
                        Text(result.averageCostYuan?.let { "参考人均：约 ${it.roundToInt()} 元" }
                            ?: "参考人均：暂无可靠信息")
                        Text(result.sourceRating?.let { "来源评分：%.1f".format(it) }
                            ?: "来源评分：暂无可靠信息")
                        Text("数据来源：${result.sourceLabel}")
                        Text("数据模式：${dataModeLabel(result.dataMode)}")
                        if (result.tags.isNotEmpty()) Text("标签：${result.tags.joinToString(" · ")}")
                    }
                }
            }

            if (result.dataMode == "DEMO") {
                item { DetailNotice("这是演示数据，不代表真实商户，请勿据此出行或保存。", warning = true) }
            } else if (result.dataMode != "LIVE") {
                item { DetailNotice("此数据模式可安全展示，但当前 App 不允许保存其餐厅引用。") }
            }

            item {
                PersistencePanel(
                    state = persistenceState,
                    resultSessionCurrent = resultSessionCurrent,
                    favoriteGate = favoriteGate,
                    feedbackGate = feedbackGate,
                    onFavorite = { group ->
                        if (resultSessionStateProvider() == ResultSessionState.CURRENT) {
                            onFavorite(group)
                        }
                    },
                    onPrivateFeedback = { type ->
                        if (resultSessionStateProvider() == ResultSessionState.CURRENT) {
                            onPrivateFeedback(type)
                        }
                    },
                    onOpenAccount = onOpenAccount,
                )
            }

            item {
                DetailNotice(
                    "营业、价格和标签可能变化；出发前请通过商户官方渠道确认。搜索结果没有 AI 生成事实。",
                )
            }
        }
    }
}

@Composable
private fun PersistencePanel(
    state: SavedResourcesUiState,
    resultSessionCurrent: Boolean,
    favoriteGate: PersistenceGateDecision,
    feedbackGate: PersistenceGateDecision,
    onFavorite: (FavoriteGroup) -> Unit,
    onPrivateFeedback: (PrivateFeedbackType) -> Unit,
    onOpenAccount: () -> Unit,
) {
    val favoriteAllowed = resultSessionCurrent && favoriteGate == PersistenceGateDecision.Allowed
    val feedbackAllowed = resultSessionCurrent && feedbackGate == PersistenceGateDecision.Allowed
    Surface(
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = MaterialTheme.shapes.large,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Text("保存到账号", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(
                "仅保存 App 自有引用；服务端会再次核验账号、数据授权和该来源的实时权限。",
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { onFavorite(FavoriteGroup.WANT_TO_GO) },
                    enabled = favoriteAllowed && !state.busy && !state.favoriteSaved,
                    modifier = Modifier.weight(1f),
                ) { Text(if (state.favoriteSaved) "已收藏" else "收藏到想去") }
                OutlinedButton(
                    onClick = { onFavorite(FavoriteGroup.REGULAR) },
                    enabled = favoriteAllowed && !state.busy && !state.favoriteSaved,
                    modifier = Modifier.weight(1f),
                ) { Text("收藏到常吃") }
            }
            if (favoriteGate is PersistenceGateDecision.Blocked) {
                Text(favoriteGate.message, style = MaterialTheme.typography.bodySmall)
            }
            Text("给自己留个私有反馈", style = MaterialTheme.typography.titleSmall)
            PrivateFeedbackType.entries.chunked(2).forEach { types ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    types.forEach { type ->
                        val submitted = type in state.submittedFeedback
                        OutlinedButton(
                            onClick = { onPrivateFeedback(type) },
                            enabled = feedbackAllowed && !state.busy && !submitted,
                            modifier = Modifier.weight(1f),
                        ) { Text(if (submitted) "已记录：${type.label()}" else type.label()) }
                    }
                    if (types.size == 1) Spacer(Modifier.weight(1f))
                }
            }
            if (feedbackGate is PersistenceGateDecision.Blocked &&
                feedbackGate.message != (favoriteGate as? PersistenceGateDecision.Blocked)?.message
            ) {
                Text(feedbackGate.message, style = MaterialTheme.typography.bodySmall)
            }
            if (state.loginRequired) {
                TextButton(onClick = onOpenAccount, enabled = !state.busy) { Text("前往登录账号") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaceSearchSessionExpiredScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("搜索结果详情") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "返回搜索结果")
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
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant) {
                    Icon(Icons.Rounded.Warning, contentDescription = null, modifier = Modifier.padding(18.dp))
                }
                Text(
                    "搜索详情会话已失效",
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.padding(top = 16.dp),
                )
                Text(
                    "搜索词、坐标和餐厅结果只保留在当前内存会话，请返回后重新搜索。",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
                TextButton(onClick = onBack) { Text("返回搜索结果") }
            }
        }
    }
}

@Composable
private fun DetailNotice(text: String, warning: Boolean = false) {
    Surface(
        color = if (warning) MaterialTheme.colorScheme.errorContainer
        else MaterialTheme.colorScheme.tertiaryContainer,
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(13.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            if (warning) Icon(Icons.Rounded.Warning, contentDescription = null)
            Text(text, style = MaterialTheme.typography.bodySmall)
        }
    }
}

private fun Modifier.actionState(status: RestaurantActionStatus, label: String): Modifier = semantics {
    status.unavailableReason?.let { stateDescription = "$label 不可用：${it.accessibilityReason}" }
}

private fun detailOpenStatus(status: OpenStatus): String = when (status) {
    OpenStatus.OPEN -> "营业中"
    OpenStatus.CLOSED -> "已打烊"
    OpenStatus.UNKNOWN -> "待确认"
}

private fun formatDetailDistance(value: Int): String = if (value < 1_000) "$value 米" else {
    "%.1f 公里".format(value / 1_000.0)
}
