package com.chishenme.app.feature.home

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings as AndroidSettings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.LocationSearchDataMode
import com.chishenme.app.data.remote.LocationSearchPlace
import com.chishenme.app.data.remote.LocationSearchQueryValidation
import com.chishenme.app.data.remote.LocationSearchQueryValidator
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.data.remote.effectiveServiceCapabilities
import com.chishenme.app.domain.BeijingPilotLocations
import com.chishenme.app.domain.LocationChoice
import com.chishenme.app.feature.decision.DecisionUiState
import com.chishenme.app.feature.decision.DecisionViewModel
import com.chishenme.app.feature.decision.LocationSearchUiState
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.location.LocationAccess
import com.chishenme.app.location.LocationSettingsTarget
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.location.LocationUiState
import com.chishenme.app.location.presentation
import kotlin.math.roundToInt

private val cuisines = listOf("中式快餐", "面食", "米饭", "火锅", "川湘菜", "清真", "素食", "西餐")

private enum class LocationPermissionRequest { INITIAL_LOCATION, PRECISION_UPGRADE }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    state: DecisionUiState,
    viewModel: DecisionViewModel,
    onOpenSettings: () -> Unit,
    onOpenPlaceSearch: () -> Unit,
    onReconnectService: () -> Unit,
    onRecommendationStarted: () -> Unit,
) {
    val context = LocalContext.current
    val activity = context.findActivity()
    val lifecycleOwner = LocalLifecycleOwner.current
    val snackbarHostState = remember { SnackbarHostState() }
    var pendingPermissionRequest by rememberSaveable {
        mutableStateOf<LocationPermissionRequest?>(null)
    }
    var precisionUpgradeRequiresSettings by rememberSaveable { mutableStateOf(false) }
    val recommendationEnabled = when (state.remoteFeatureConfig) {
        is RemoteFeatureConfigState.Ready ->
            state.featureConfig?.effectiveServiceCapabilities()?.recommendationsEnabled == true
        is RemoteFeatureConfigState.Unavailable -> true
        is RemoteFeatureConfigState.Loading,
        is RemoteFeatureConfigState.Incompatible,
        -> false
    }

    fun locateOnlyWhileHomeStarted() {
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            viewModel.locate()
        } else {
            viewModel.cancelLocationRequest()
        }
    }

    val locationPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val request = pendingPermissionRequest ?: LocationPermissionRequest.INITIAL_LOCATION
        pendingPermissionRequest = null
        val coarseGranted = context.hasCoarseLocationPermission()
        val fineGranted = context.hasFineLocationPermission()

        when {
            fineGranted -> {
                precisionUpgradeRequiresSettings = false
                locateOnlyWhileHomeStarted()
            }
            request == LocationPermissionRequest.PRECISION_UPGRADE && coarseGranted -> {
                val canAskForFineAgain = activity?.let { host ->
                    ActivityCompat.shouldShowRequestPermissionRationale(
                        host,
                        Manifest.permission.ACCESS_FINE_LOCATION,
                    )
                } ?: true
                precisionUpgradeRequiresSettings = result.isNotEmpty() && !canAskForFineAgain
                viewModel.showMessage(
                    when {
                        result.isEmpty() -> "已取消提高定位精度，继续使用大致位置"
                        precisionUpgradeRequiresSettings -> "仍使用大致位置；如需精确位置，请前往应用设置开启"
                        else -> "未提高定位精度，继续使用大致位置"
                    },
                )
            }
            coarseGranted -> {
                // Approximate access is sufficient for the complete recommendation flow.
                precisionUpgradeRequiresSettings = false
                locateOnlyWhileHomeStarted()
            }
            else -> {
                val mayAskAgain = activity?.let { host ->
                    ActivityCompat.shouldShowRequestPermissionRationale(
                        host,
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                    ) || ActivityCompat.shouldShowRequestPermissionRationale(
                        host,
                        Manifest.permission.ACCESS_FINE_LOCATION,
                    )
                } ?: true
                val denial = classifyLocationPermissionDenial(
                    resultWasEmpty = result.isEmpty(),
                    shouldShowRationale = mayAskAgain,
                )
                viewModel.onLocationPermissionDenied(
                    permanentlyDenied = denial == LocationPermissionDenial.PERMANENT,
                )
            }
        }
    }

    DisposableEffect(lifecycleOwner, viewModel) {
        var configurationChangeObserved = false
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                viewModel.cancelLocationRequest()
                val changingConfigurations = activity?.isChangingConfigurations == true
                configurationChangeObserved =
                    configurationChangeObserved || changingConfigurations
                if (!changingConfigurations) {
                    viewModel.dismissLocationSearch()
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            viewModel.cancelLocationRequest()
            if (!configurationChangeObserved && activity?.isChangingConfigurations != true) {
                viewModel.dismissLocationSearch()
            }
        }
    }

    LaunchedEffect(state.transientMessage) {
        state.transientMessage?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("吃什么", fontWeight = FontWeight.Bold)
                        Text(
                            "现在这一顿，30 秒决定",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Rounded.Settings, contentDescription = "设置")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
    ) { contentPadding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(contentPadding),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            remoteServiceStatusMessage(state)?.let { message ->
                item {
                    RemoteServiceStatusCard(
                        message = message,
                        onReconnect = onReconnectService,
                    )
                }
            }
            item {
                LocationCard(
                    location = state.input.location,
                    locationState = state.locationState,
                    offerPrecisionUpgrade = shouldOfferPrecisionUpgrade(
                        coarseGranted = context.hasCoarseLocationPermission(),
                        fineGranted = context.hasFineLocationPermission(),
                    ),
                    precisionUpgradeRequiresSettings = precisionUpgradeRequiresSettings,
                    isPrecisionRequestInFlight =
                        pendingPermissionRequest == LocationPermissionRequest.PRECISION_UPGRADE,
                    onLocate = {
                        if (context.hasCoarseLocationPermission()) {
                            viewModel.locate()
                        } else {
                            pendingPermissionRequest = LocationPermissionRequest.INITIAL_LOCATION
                            viewModel.onLocationPermissionRequestStarted()
                            // Android 12+ requires COARSE and FINE to be requested together so
                            // the user can intentionally choose approximate-only access.
                            locationPermissionLauncher.launch(
                                arrayOf(
                                    Manifest.permission.ACCESS_COARSE_LOCATION,
                                    Manifest.permission.ACCESS_FINE_LOCATION,
                                ),
                            )
                        }
                    },
                    onImproveAccuracy = {
                        when {
                            context.hasFineLocationPermission() -> viewModel.locate()
                            precisionUpgradeRequiresSettings -> {
                                context.startActivity(
                                    Intent(
                                        AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                        "package:${context.packageName}".toUri(),
                                    ),
                                )
                            }
                            context.hasCoarseLocationPermission() -> {
                                pendingPermissionRequest = LocationPermissionRequest.PRECISION_UPGRADE
                                // Android 12+ requires both permissions in the same request.
                                // This request is reachable only from the explicit upgrade button.
                                locationPermissionLauncher.launch(
                                    arrayOf(
                                        Manifest.permission.ACCESS_COARSE_LOCATION,
                                        Manifest.permission.ACCESS_FINE_LOCATION,
                                    ),
                                )
                            }
                            else -> {
                                pendingPermissionRequest = LocationPermissionRequest.INITIAL_LOCATION
                                viewModel.onLocationPermissionRequestStarted()
                                locationPermissionLauncher.launch(
                                    arrayOf(
                                        Manifest.permission.ACCESS_COARSE_LOCATION,
                                        Manifest.permission.ACCESS_FINE_LOCATION,
                                    ),
                                )
                            }
                        }
                    },
                    onChoose = viewModel::openLocationChooser,
                    onOpenLocationSettings = {
                        context.startActivity(Intent(AndroidSettings.ACTION_LOCATION_SOURCE_SETTINGS))
                    },
                    onOpenAppSettings = {
                        context.startActivity(
                            Intent(
                                AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                "package:${context.packageName}".toUri(),
                            ),
                        )
                    },
                )
            }

            item {
                Surface(
                    color = MaterialTheme.colorScheme.tertiaryContainer,
                    shape = MaterialTheme.shapes.large,
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            "已经知道想吃什么？",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "直接搜索附近餐厅、菜系或食物。它与“手动选地点”和“帮我决定”是三个独立功能。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onTertiaryContainer,
                        )
                        OutlinedButton(
                            onClick = {
                                if (state.input.location == null) {
                                    viewModel.showMessage("请先自动定位或手动选择地点，再搜索附近餐厅")
                                } else {
                                    onOpenPlaceSearch()
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(AppIcons.Restaurant, contentDescription = null)
                            Spacer(Modifier.width(7.dp))
                            Text("搜索附近餐厅 / 菜系 / 食物")
                        }
                    }
                }
            }

            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionTitle("怎么决定", "极速模式一键给答案，精细模式可调全部条件")
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ModeButton(
                            modifier = Modifier.weight(1f),
                            selected = state.input.decisionMode == DecisionMode.QUICK,
                            title = "极速决定",
                            subtitle = "少操作",
                            onClick = { viewModel.setDecisionMode(DecisionMode.QUICK) },
                        )
                        ModeButton(
                            modifier = Modifier.weight(1f),
                            selected = state.input.decisionMode == DecisionMode.GUIDED,
                            title = "精细匹配",
                            subtitle = "更可控",
                            onClick = { viewModel.setDecisionMode(DecisionMode.GUIDED) },
                        )
                    }
                }
            }

            item {
                OptionSection(
                    title = "这一顿",
                    options = MealPeriod.entries.map { period ->
                        period to when (period) {
                            MealPeriod.BREAKFAST -> "早餐"
                            MealPeriod.LUNCH -> "午餐"
                            MealPeriod.DINNER -> "晚餐"
                        }
                    },
                    selected = state.input.mealPeriod,
                    onSelected = viewModel::setMealPeriod,
                )
            }

            if (state.input.decisionMode == DecisionMode.QUICK) {
                item {
                    Surface(
                        color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.55f),
                        shape = MaterialTheme.shapes.large,
                    ) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("当前极速条件", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "人均 ${state.input.budgetMaxYuan?.let { "${it}元内" } ?: "不限"} · " +
                                    "${state.input.availableMinutes} 分钟 · ${travelLabel(state.input.travelMode)} · " +
                                    explorationLabel(state.input.explorationMode),
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                            Text(
                                "切换到“精细匹配”可以调整这些条件。",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            } else {
                item {
                    OptionSection(
                        title = "人均预算",
                        options = listOf<Pair<Int?, String>>(
                            15 to "15 元内",
                            25 to "25 元内",
                            40 to "40 元内",
                            null to "不限",
                        ),
                        selected = state.input.budgetMaxYuan,
                        onSelected = viewModel::setBudget,
                    )
                }
                item {
                    OptionSection(
                        title = "一共可用多久",
                        options = listOf(30, 45, 60, 90).map { it to "$it 分钟" },
                        selected = state.input.availableMinutes,
                        onSelected = viewModel::setAvailableMinutes,
                    )
                }
                item {
                    OptionSection(
                        title = "交通方式",
                        options = listOf(
                            TravelMode.WALK to "步行",
                            TravelMode.BIKE to "骑行",
                            TravelMode.TRANSIT to "公交/地铁",
                        ),
                        selected = state.input.travelMode,
                        onSelected = viewModel::setTravelMode,
                    )
                }
                item {
                    OptionSection(
                        title = "探索偏好",
                        options = listOf(
                            ExplorationMode.SAFE to "稳妥吃",
                            ExplorationMode.BALANCED to "平衡",
                            ExplorationMode.ADVENTUROUS to "换个口味",
                        ),
                        selected = state.input.explorationMode,
                        onSelected = viewModel::setExplorationMode,
                    )
                }
                item {
                    OptionSection(
                        title = "最远距离",
                        options = listOf(
                            1_000 to "1 km",
                            1_500 to "1.5 km",
                            3_000 to "3 km",
                            5_000 to "5 km",
                        ),
                        selected = state.input.radiusMeters,
                        onSelected = viewModel::setRadius,
                    )
                }
                item {
                    PartySizeRow(
                        partySize = state.input.partySize,
                        onChange = viewModel::setPartySize,
                    )
                }
                item {
                    CuisineSection(
                        title = "更想吃",
                        selected = state.input.preferredCuisines,
                        onToggle = { viewModel.toggleCuisine(it, preferred = true) },
                    )
                }
                item {
                    CuisineSection(
                        title = "这次不吃",
                        selected = state.input.excludedCuisines,
                        onToggle = { viewModel.toggleCuisine(it, preferred = false) },
                    )
                }
            }

            item {
                state.formError?.let { error ->
                    Text(
                        error,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                Button(
                    onClick = {
                        if (viewModel.recommend()) onRecommendationStarted()
                    },
                    enabled = recommendationEnabled,
                    modifier = Modifier.fillMaxWidth().height(58.dp),
                ) {
                    Icon(AppIcons.Restaurant, contentDescription = null)
                    Spacer(Modifier.width(9.dp))
                    Text("帮我决定")
                }
                Text(
                    "给出 1 个主推荐和 2 个备选，不展示无限信息流",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }
        }
    }

    if (state.locationChooserOpen) {
        LocationChooserDialog(
            query = state.locationSearchQuery,
            searchState = state.locationSearchState,
            remoteFeatureConfig = state.remoteFeatureConfig,
            onSearch = viewModel::searchLocation,
            onDismiss = viewModel::dismissLocationSearch,
            onChoose = viewModel::setLocation,
            onChooseSearchResult = { place, dataMode ->
                viewModel.selectLocationSearchResult(place, dataMode)
            },
            onQueryChanged = viewModel::updateLocationSearchQuery,
        )
    }
}

internal fun remoteServiceStatusMessage(state: DecisionUiState): String? =
    when (val remote = state.remoteFeatureConfig) {
        is RemoteFeatureConfigState.Loading -> "正在连接云端服务，连接完成后即可开始。"
        is RemoteFeatureConfigState.Unavailable ->
            "云端配置暂不可用。你仍可尝试一次不含 AI 的规则推荐；地点搜索、餐厅搜索和账号能力已关闭。"
        is RemoteFeatureConfigState.Incompatible ->
            "当前 App 与云端服务版本不兼容，远程功能已安全关闭。"
        is RemoteFeatureConfigState.Ready -> {
            val capabilities = remote.config.effectiveServiceCapabilities()
            val unavailable = buildList {
                if (!capabilities.recommendationsEnabled) add("餐厅推荐")
                if (!capabilities.locationSearchEnabled) add("地点搜索")
                if (!capabilities.placeSearchEnabled) add("餐厅搜索")
            }
            unavailable.takeIf { it.isNotEmpty() }
                ?.joinToString(prefix = "云端已连接，但以下服务尚未开放：", postfix = "。")
        }
    }

@Composable
private fun RemoteServiceStatusCard(
    message: String,
    onReconnect: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = MaterialTheme.shapes.large,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("服务状态", style = MaterialTheme.typography.titleMedium)
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            OutlinedButton(onClick = onReconnect) {
                Text("重新连接服务")
            }
        }
    }
}

@Composable
private fun LocationCard(
    location: LocationChoice?,
    locationState: LocationUiState,
    offerPrecisionUpgrade: Boolean,
    precisionUpgradeRequiresSettings: Boolean,
    isPrecisionRequestInFlight: Boolean,
    onLocate: () -> Unit,
    onImproveAccuracy: () -> Unit,
    onChoose: () -> Unit,
    onOpenLocationSettings: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    val isLocating = locationState is LocationUiState.AwaitingPermission ||
        locationState is LocationUiState.Locating ||
        isPrecisionRequestInFlight
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.LocationOn, null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text("从哪里出发", style = MaterialTheme.typography.labelLarge)
                    Text(
                        location?.label ?: "尚未选择地点",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
            }
            if (location?.isDemonstration == true) {
                Text(
                    "演示位置只在本次会话使用，不会写入历史。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            when (locationState) {
                LocationUiState.Idle -> if (location != null && !location.isDemonstration) {
                    LocationPrivacySummary(location)
                }
                LocationUiState.AwaitingPermission -> LocationProgress("等待你选择位置精度…")
                LocationUiState.Locating -> LocationProgress("正在获取当前位置…")
                is LocationUiState.Ready -> {
                    Text(
                        buildString {
                            append(
                                if (locationState.access == LocationAccess.APPROXIMATE) {
                                    "已使用系统提供的大致位置"
                                } else {
                                    "已取得当前位置"
                                },
                            )
                            locationState.accuracyMeters?.let { append("，精度约 ${formatAccuracy(it)}") }
                            append("。坐标只用于当次推荐，不保存。")
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
                is LocationUiState.Failed -> {
                    val presentation = locationState.reason.presentation()
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            presentation.message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        when (presentation.settingsTarget) {
                            LocationSettingsTarget.APP -> TextButton(onClick = onOpenAppSettings) {
                                Text("打开应用设置")
                            }
                            LocationSettingsTarget.DEVICE_LOCATION -> TextButton(onClick = onOpenLocationSettings) {
                                Text("打开系统定位")
                            }
                            LocationSettingsTarget.NONE -> Unit
                        }
                    }
                }
            }
            if (offerPrecisionUpgrade) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        if (precisionUpgradeRequiresSettings) {
                            "当前只有大致位置权限。如需精确位置，请由你主动前往应用设置开启。"
                        } else {
                            "当前只有大致位置权限；继续使用不影响推荐，也可由你主动提高精度。"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    TextButton(
                        onClick = onImproveAccuracy,
                        enabled = !isLocating,
                    ) {
                        Icon(AppIcons.MyLocation, null, modifier = Modifier.width(18.dp).height(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(
                            when {
                                isPrecisionRequestInFlight -> "等待系统选择"
                                precisionUpgradeRequiresSettings -> "前往设置提高精度"
                                else -> "提高定位精度"
                            },
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FilledTonalButton(
                    onClick = onLocate,
                    enabled = !isLocating,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(AppIcons.MyLocation, null)
                    Spacer(Modifier.width(6.dp))
                    Text(if (isLocating) "定位中" else "自动定位")
                }
                OutlinedButton(onClick = onChoose, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Rounded.LocationOn, null)
                    Spacer(Modifier.width(6.dp))
                    Text("手动选择")
                }
            }
        }
    }
}

@Composable
private fun LocationProgress(message: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(modifier = Modifier.width(16.dp).height(16.dp), strokeWidth = 2.dp)
        Text(
            message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
    }
}

@Composable
private fun LocationPrivacySummary(location: LocationChoice) {
    Text(
        buildString {
            append(if (location.isApproximate) "当前为大致位置" else "当前为系统定位")
            location.coordinate.accuracyMeters?.let { append("，精度约 ${formatAccuracy(it)}") }
            append("。坐标只用于当次推荐，不保存。")
        },
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

private fun formatAccuracy(accuracyMeters: Double): String {
    val rounded = accuracyMeters.roundToInt().coerceAtLeast(1)
    return if (rounded >= 1_000) {
        "${(rounded / 100.0).roundToInt() / 10.0} 公里"
    } else {
        "$rounded 米"
    }
}

private fun Context.hasCoarseLocationPermission(): Boolean =
    ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

private fun Context.hasFineLocationPermission(): Boolean =
    ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun ModeButton(
    selected: Boolean,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier,
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer
            else MaterialTheme.colorScheme.surface,
        ),
        border = if (selected) null else CardDefaults.outlinedCardBorder(),
    ) {
        Column(Modifier.padding(16.dp)) {
            Icon(if (selected) AppIcons.Restaurant else AppIcons.Tune, null)
            Spacer(Modifier.height(8.dp))
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun SectionTitle(title: String, subtitle: String? = null) {
    Column {
        Text(title, style = MaterialTheme.typography.titleMedium)
        subtitle?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun <T> OptionSection(
    title: String,
    options: List<Pair<T, String>>,
    selected: T,
    onSelected: (T) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(title)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(options) { (value, label) ->
                FilterChip(
                    selected = value == selected,
                    onClick = { onSelected(value) },
                    label = { Text(label) },
                )
            }
        }
    }
}

@Composable
private fun PartySizeRow(partySize: Int, onChange: (Int) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle("就餐人数")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            OutlinedButton(onClick = { onChange(partySize - 1) }, enabled = partySize > 1) { Text("−") }
            Text("$partySize 人", style = MaterialTheme.typography.titleMedium)
            OutlinedButton(onClick = { onChange(partySize + 1) }, enabled = partySize < 30) { Text("+") }
        }
    }
}

@Composable
private fun CuisineSection(title: String, selected: Set<String>, onToggle: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(title)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(cuisines) { cuisine ->
                FilterChip(
                    selected = cuisine in selected,
                    onClick = { onToggle(cuisine) },
                    label = { Text(cuisine) },
                )
            }
        }
    }
}

@Composable
private fun LocationChooserDialog(
    query: String,
    searchState: LocationSearchUiState,
    remoteFeatureConfig: RemoteFeatureConfigState,
    onSearch: () -> Unit,
    onDismiss: () -> Unit,
    onChoose: (LocationChoice) -> Unit,
    onChooseSearchResult: (LocationSearchPlace, LocationSearchDataMode) -> Unit,
    onQueryChanged: (String) -> Unit,
) {
    val queryValidation = LocationSearchQueryValidator.validate(query)
    val isLoading = searchState == LocationSearchUiState.Loading
    val remoteSearchAvailable =
        (remoteFeatureConfig as? RemoteFeatureConfigState.Ready)
            ?.config?.effectiveServiceCapabilities()?.locationSearchEnabled == true
    val remoteSearchLabel = when (remoteFeatureConfig) {
        is RemoteFeatureConfigState.Loading -> "地点服务准备中"
        is RemoteFeatureConfigState.Ready -> if (remoteSearchAvailable) {
            "搜索地点"
        } else {
            "地点搜索当前未开放"
        }
        is RemoteFeatureConfigState.Unavailable -> "地点搜索当前不可用"
        is RemoteFeatureConfigState.Incompatible -> "地点搜索版本不兼容"
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("搜索或选择地点") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "可输入北京的学校、商圈或地址。输入内容仅用于本次搜索，不保存；结果会明确显示数据来源。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = query,
                    onValueChange = { value ->
                        // Keep one extra character so the local validator can
                        // explain the limit instead of silently truncating.
                        onQueryChanged(value.take(81))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("学校、商圈或地址") },
                    placeholder = { Text("例如：中关村软件园") },
                    singleLine = true,
                    isError = query.isNotEmpty() && queryValidation is LocationSearchQueryValidation.Invalid,
                    supportingText = {
                        if (query.isNotEmpty() && queryValidation is LocationSearchQueryValidation.Invalid) {
                            Text(queryValidation.message)
                        } else {
                            Text("至少 2 个字符")
                        }
                    },
                )
                Button(
                    onClick = onSearch,
                    enabled = queryValidation is LocationSearchQueryValidation.Valid &&
                        remoteSearchAvailable &&
                        !isLoading,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (isLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.width(18.dp).height(18.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(if (isLoading) "搜索中" else remoteSearchLabel)
                }
                if (!remoteSearchAvailable) {
                    Text(
                        when (remoteFeatureConfig) {
                            is RemoteFeatureConfigState.Loading ->
                                "正在确认服务兼容性；你仍可先选择下方快捷地点。"
                            is RemoteFeatureConfigState.Unavailable ->
                                "暂时无法确认地点服务；你仍可选择下方快捷地点。"
                            is RemoteFeatureConfigState.Incompatible ->
                                "当前 App 无法安全使用地点搜索；请更新后重试，或使用快捷地点。"
                            is RemoteFeatureConfigState.Ready -> ""
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                LocationSearchContent(
                    state = searchState,
                    onChoose = onChooseSearchResult,
                )

                HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
                Text("快捷地点（始终可用）", style = MaterialTheme.typography.titleSmall)
                Text(
                    "以下 5 个内置演示地点可在拒绝定位、断网或搜索失败时完成流程。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                BeijingPilotLocations.choices.forEachIndexed { index, location ->
                    TextButton(onClick = { onChoose(location) }, modifier = Modifier.fillMaxWidth()) {
                        Text(location.label, modifier = Modifier.weight(1f))
                    }
                    if (index != BeijingPilotLocations.choices.lastIndex) HorizontalDivider()
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun LocationSearchContent(
    state: LocationSearchUiState,
    onChoose: (LocationSearchPlace, LocationSearchDataMode) -> Unit,
) {
    when (state) {
        LocationSearchUiState.Idle,
        LocationSearchUiState.Loading -> Unit
        is LocationSearchUiState.Failed -> Text(
            state.message,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
        )
        is LocationSearchUiState.Empty -> {
            Text("没有找到匹配地点，请换个关键词或使用快捷地点。")
            state.notice?.takeIf(String::isNotBlank)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
        }
        is LocationSearchUiState.Ready -> {
            val sourceLabels = state.results.map { it.sourceLabel }.distinct().joinToString("、")
            Text(
                "输入内容会发送给 $sourceLabels 用于本次搜索，不保存。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            state.notice?.takeIf(String::isNotBlank)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            state.results.forEachIndexed { index, place ->
                TextButton(
                    onClick = { onChoose(place, state.dataMode) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                        Text(place.name, fontWeight = FontWeight.SemiBold)
                        place.address?.takeIf(String::isNotBlank)?.let { address ->
                            Text(
                                address,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(
                            "来源：${place.sourceLabel} · 数据源顺序 ${place.providerRank}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (index != state.results.lastIndex) HorizontalDivider()
            }
        }
    }
}

private fun travelLabel(mode: TravelMode) = when (mode) {
    TravelMode.WALK -> "只步行"
    TravelMode.BIKE -> "可骑行"
    TravelMode.TRANSIT -> "可乘公共交通"
}

private fun explorationLabel(mode: ExplorationMode) = when (mode) {
    ExplorationMode.SAFE -> "稳妥吃"
    ExplorationMode.BALANCED -> "平衡选择"
    ExplorationMode.ADVENTUROUS -> "换个口味"
}
