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
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
import com.chishenme.app.data.remote.RecommendationTarget
import com.chishenme.app.data.remote.SpecialtyCapabilities
import com.chishenme.app.data.remote.LocationSearchDataMode
import com.chishenme.app.data.remote.LocationSearchPlace
import com.chishenme.app.data.remote.LocationSearchQueryValidation
import com.chishenme.app.data.remote.LocationSearchQueryValidator
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.data.remote.UserReportedWeatherPreference
import com.chishenme.app.data.remote.effectiveServiceCapabilities
import com.chishenme.app.data.remote.effectiveSpecialtyCapabilities
import com.chishenme.app.domain.BuiltInQuickLocations
import com.chishenme.app.domain.DecisionScenario
import com.chishenme.app.domain.LocationChoice
import com.chishenme.app.domain.RecommendationRadiusPolicy
import com.chishenme.app.feature.decision.DecisionUiState
import com.chishenme.app.feature.decision.DecisionViewModel
import com.chishenme.app.feature.decision.LocationSearchUiState
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.location.LocationAccess
import com.chishenme.app.location.LocationSettingsTarget
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppSnackbarHost
import com.chishenme.app.ui.AppTopBar
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
    onReconnectService: () -> Unit,
    onRecommendationStarted: () -> Unit,
    groupDecisionEnabled: Boolean,
    onOpenGroupDecision: () -> Unit,
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
    val specialtyCapabilities =
        (state.remoteFeatureConfig as? RemoteFeatureConfigState.Ready)
            ?.config
            ?.effectiveSpecialtyCapabilities()
    val availableSpecialtyTargets = specialtyTargetOptions(specialtyCapabilities)
    val availableMealPeriods = mealPeriodOptions(specialtyCapabilities)
    val recommendationDefaults = state.featureConfig?.recommendationDefaults
    val maximumRadius = RecommendationRadiusPolicy.maximumRadius(recommendationDefaults)

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

    HomeSurfaceTheme {
        val homeColors = currentHomeVisualColors()
        Scaffold(
            containerColor = homeColors.page,
            snackbarHost = { AppSnackbarHost(snackbarHostState) },
            topBar = {
                AppTopBar(
                    title = "吃什么",
                    subtitle = "现在这一顿，30 秒决定",
                    actions = {
                        Surface(
                            modifier = Modifier.padding(end = 10.dp).size(48.dp),
                            color = homeColors.card,
                            shape = MaterialTheme.shapes.medium,
                            border = BorderStroke(1.dp, homeColors.border),
                            shadowElevation = 1.dp,
                        ) {
                            IconButton(onClick = onOpenSettings) {
                                Icon(Icons.Rounded.Settings, contentDescription = "设置")
                            }
                        }
                    },
                )
            },
        ) { contentPadding ->
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(contentPadding),
                contentPadding = PaddingValues(
                    horizontal = HomeDimens.ScreenHorizontal,
                    vertical = HomeDimens.SectionGap,
                ),
                verticalArrangement = Arrangement.spacedBy(HomeDimens.SectionGap),
            ) {
                item { HomeHeroCard() }
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
            if (groupDecisionEnabled) {
                item {
                    GroupDecisionEntryCard(
                        location = state.input.location,
                        onOpen = onOpenGroupDecision,
                    )
                }
            }

            item {
                HomeCard {
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
                    title = "主动场景",
                    subtitle = "一键套用常用条件；地点和已选菜系保持不变",
                    options = DecisionScenario.entries.map { scenario ->
                        scenario to scenarioLabel(scenario)
                    },
                    selected = state.activeScenario,
                    onSelected = viewModel::applyScenario,
                )
            }

            if (availableSpecialtyTargets.isNotEmpty()) {
                item {
                    OptionSection(
                        title = "想决定什么",
                        subtitle = "专项入口只在当前数据源明确支持时开放",
                        options = listOf(RecommendationTarget.MEAL to "普通用餐") +
                            availableSpecialtyTargets,
                        selected = state.input.target,
                        onSelected = viewModel::setRecommendationTarget,
                    )
                }
            }

            item {
                OptionSection(
                    title = "这一顿",
                    subtitle = when (state.input.mealPeriod) {
                        MealPeriod.BREAKFAST -> if (
                            specialtyCapabilities?.breakfastProfileEnabled == true
                        ) "已启用早餐专项查询" else null
                        MealPeriod.LUNCH -> null
                        MealPeriod.DINNER -> if (
                            specialtyCapabilities?.dinnerProfileEnabled == true
                        ) "已启用晚餐专项查询" else null
                    },
                    options = availableMealPeriods,
                    selected = state.input.mealPeriod,
                    onSelected = viewModel::setMealPeriod,
                )
            }

            if (specialtyCapabilities?.userReportedWeatherEnabled == true) {
                item {
                    OptionSection(
                        title = "手动体感（可选）",
                        subtitle = "只用你本次主动选择的体感；不读取天气、温度或后台位置",
                        options = listOf<Pair<UserReportedWeatherPreference?, String>>(
                            null to "不使用",
                            UserReportedWeatherPreference.MINIMIZE_EXPOSURE to "少在户外停留",
                            UserReportedWeatherPreference.WARMING to "想吃喝暖一点",
                            UserReportedWeatherPreference.COOLING to "想吃喝清凉一点",
                        ),
                        selected = state.input.weatherContext.preference,
                        onSelected = viewModel::setUserReportedWeather,
                    )
                }
            }

            if (state.input.decisionMode == DecisionMode.QUICK) {
                item {
                    QuickDecisionSummary(
                        budgetMaxYuan = state.input.budgetMaxYuan,
                        availableMinutes = state.input.availableMinutes,
                        travelMode = state.input.travelMode,
                        explorationMode = state.input.explorationMode,
                    )
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
                        subtitle = recommendationDefaults?.let {
                            "当前服务最远支持 ${it.maximumRadiusMeters} 米；保留你主动选择的距离。"
                        },
                        options = (
                            listOf(1_000, 1_500, 3_000, 5_000).filter { it <= maximumRadius } +
                                listOfNotNull(
                                    recommendationDefaults?.defaultRadiusMeters,
                                    recommendationDefaults?.maximumRadiusMeters,
                                ) + state.input.radiusMeters
                            ).distinct().sorted().map { radius ->
                                radius to when {
                                    radius < 1_000 -> "$radius m"
                                    radius % 1_000 == 0 -> "${radius / 1_000} km"
                                    else -> "${radius / 1_000.0} km"
                                }
                            },
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
                HomeCard {
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(
                            "准备好了",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "不做无限信息流，把符合这次条件的候选清楚地放到你面前。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    (state.formError ?: state.radiusError)?.let { error ->
                        Surface(
                            modifier = Modifier.semantics {
                                liveRegion = LiveRegionMode.Assertive
                                stateDescription = error
                            },
                            color = MaterialTheme.colorScheme.errorContainer,
                            shape = MaterialTheme.shapes.small,
                        ) {
                            Text(
                                error,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                            )
                        }
                    }
                    if (state.radiusError != null) {
                        val suggestedRadius = RecommendationRadiusPolicy.automaticRadius(
                            state.input.mealPeriod,
                            recommendationDefaults,
                        )
                        TextButton(onClick = { viewModel.setRadius(suggestedRadius) }) {
                            Text("将最远距离改为 $suggestedRadius 米")
                        }
                    }
                    HomePrimaryAction(
                        enabled = recommendationEnabled,
                        onClick = {
                            if (viewModel.recommend()) onRecommendationStarted()
                        },
                    )
                    Text(
                        "最多展示 3 个符合条件的候选 · 每个候选附可核对理由",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
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
}

@Composable
private fun GroupDecisionEntryCard(
    location: LocationChoice?,
    onOpen: () -> Unit,
) {
    val colors = currentHomeVisualColors()
    HomeCard {
        Row(
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HomeIconTile(colors.blueSoft) {
                Icon(
                    AppIcons.Tune,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.size(21.dp),
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "多人一起选",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "2–8 人在同一台手机轮流填写结构化条件；不创建房间、账号或成员档案。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Button(
            onClick = onOpen,
            enabled = location != null,
            modifier = Modifier.fillMaxWidth().heightIn(min = HomeDimens.MinTouchTarget),
        ) {
            Text(if (location == null) "先选择共同出发地点" else "开始同机填写")
        }
        Text(
            "成员条件不写入本地存储；提交时只随共同地点与交通方式发送给服务，用于本次求交。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

internal fun remoteServiceStatusMessage(state: DecisionUiState): String? =
    when (val remote = state.remoteFeatureConfig) {
        is RemoteFeatureConfigState.Loading -> "正在连接云端服务，连接完成后即可开始。"
        is RemoteFeatureConfigState.Unavailable ->
            "云端配置暂不可用。你仍可尝试一次不含 AI 的规则推荐；地点搜索和账号能力已关闭。"
        is RemoteFeatureConfigState.Incompatible ->
            "当前 App 与云端服务版本不兼容，远程功能已安全关闭。"
        is RemoteFeatureConfigState.Ready -> {
            val capabilities = remote.config.effectiveServiceCapabilities()
            val unavailable = buildList {
                if (!capabilities.recommendationsEnabled) add("餐厅推荐")
                if (!capabilities.locationSearchEnabled) add("地点搜索")
            }
            unavailable.takeIf { it.isNotEmpty() }
                ?.joinToString(prefix = "云端已连接，但以下服务尚未开放：", postfix = "。")
        }
    }

internal fun specialtyTargetOptions(
    capabilities: SpecialtyCapabilities?,
): List<Pair<RecommendationTarget, String>> = buildList {
    if (capabilities?.milkTeaEnabled == true) add(RecommendationTarget.MILK_TEA to "奶茶")
    if (capabilities?.coffeeEnabled == true) add(RecommendationTarget.COFFEE to "咖啡")
    if (capabilities?.dessertEnabled == true) add(RecommendationTarget.DESSERT to "甜品")
}

internal fun mealPeriodOptions(
    capabilities: SpecialtyCapabilities?,
): List<Pair<MealPeriod, String>> = buildList {
    if (capabilities?.breakfastProfileEnabled == true) add(MealPeriod.BREAKFAST to "早餐")
    add(MealPeriod.LUNCH to "午餐")
    if (capabilities?.dinnerProfileEnabled == true) add(MealPeriod.DINNER to "晚餐")
}

@Composable
private fun RemoteServiceStatusCard(
    message: String,
    onReconnect: () -> Unit,
) {
    val colors = currentHomeVisualColors()
    HomeCard(
        modifier = Modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            stateDescription = message
        },
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HomeIconTile(colors.blueSoft) {
                Icon(
                    AppIcons.Tune,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.size(21.dp),
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "服务状态",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        OutlinedButton(
            onClick = onReconnect,
            modifier = Modifier.heightIn(min = HomeDimens.MinTouchTarget),
        ) {
            Text("重新连接服务")
        }
    }
}

@Composable
private fun QuickDecisionSummary(
    budgetMaxYuan: Int?,
    availableMinutes: Int,
    travelMode: TravelMode,
    explorationMode: ExplorationMode,
) {
    val colors = currentHomeVisualColors()
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = colors.greenSoft),
        shape = RoundedCornerShape(HomeDimens.CardRadius),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column(
            modifier = Modifier.padding(HomeDimens.CardPadding),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                HomeIconTile(colors.card.copy(alpha = 0.72f)) {
                    Icon(
                        AppIcons.AccessTime,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.size(21.dp),
                    )
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "当前极速条件",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "已经替你收好常用条件，可以直接开始。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Surface(
                color = colors.card.copy(alpha = 0.72f),
                shape = MaterialTheme.shapes.small,
            ) {
                Text(
                    "人均 ${budgetMaxYuan?.let { "${it}元内" } ?: "不限"} · " +
                        "$availableMinutes 分钟 · ${travelLabel(travelMode)} · " +
                        explorationLabel(explorationMode),
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
            }
            Text(
                "切换到“精细匹配”可以调整这些条件。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
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
    val colors = currentHomeVisualColors()
    val isLocating = locationState is LocationUiState.AwaitingPermission ||
        locationState is LocationUiState.Locating ||
        isPrecisionRequestInFlight
    HomeCard {
        Row(
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HomeIconTile(colors.accentSoft) {
                Icon(
                    Icons.Rounded.LocationOn,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(22.dp),
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "从哪里出发",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    location?.label ?: "尚未选择地点",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
            Surface(
                color = if (location == null) colors.amberSoft else colors.greenSoft,
                shape = RoundedCornerShape(50),
            ) {
                Text(
                    if (location == null) "待选择" else "已选择",
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }

        if (location?.isDemonstration == true) {
            LocationNotice(
                text = "演示位置只在本次会话使用，不会写入历史。",
                background = colors.amberSoft,
            )
        }
        when (locationState) {
            LocationUiState.Idle -> if (location != null && !location.isDemonstration) {
                LocationPrivacySummary(location)
            } else if (location == null) {
                LocationNotice(
                    text = "定位只会在你主动点击后开始；坐标只用于当次推荐。",
                    background = colors.cardMuted,
                )
            }
            LocationUiState.AwaitingPermission -> LocationProgress("等待你选择位置精度…")
            LocationUiState.Locating -> LocationProgress("正在获取当前位置…")
            is LocationUiState.Ready -> {
                LocationNotice(
                    text = buildString {
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
                    background = colors.greenSoft,
                    announce = true,
                )
            }
            is LocationUiState.Failed -> {
                val presentation = locationState.reason.presentation()
                Surface(
                    modifier = Modifier.semantics {
                        liveRegion = LiveRegionMode.Polite
                        stateDescription = presentation.message
                    },
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            presentation.message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
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
        }
        if (offerPrecisionUpgrade) {
            Surface(
                color = colors.blueSoft,
                shape = MaterialTheme.shapes.small,
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        if (precisionUpgradeRequiresSettings) {
                            "当前只有大致位置权限。如需精确位置，请由你主动前往应用设置开启。"
                        } else {
                            "当前只有大致位置权限；继续使用不影响推荐，也可由你主动提高精度。"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(
                        onClick = onImproveAccuracy,
                        enabled = !isLocating,
                    ) {
                        Icon(AppIcons.MyLocation, null, modifier = Modifier.size(18.dp))
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
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilledTonalButton(
                onClick = onLocate,
                enabled = !isLocating,
                modifier = Modifier.weight(1f).heightIn(min = HomeDimens.MinTouchTarget),
            ) {
                Icon(AppIcons.MyLocation, null, modifier = Modifier.size(19.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (isLocating) "定位中" else "自动定位")
            }
            OutlinedButton(
                onClick = onChoose,
                modifier = Modifier.weight(1f).heightIn(min = HomeDimens.MinTouchTarget),
            ) {
                Icon(Icons.Rounded.LocationOn, null, modifier = Modifier.size(19.dp))
                Spacer(Modifier.width(6.dp))
                Text("手动选择")
            }
        }
    }
}

@Composable
private fun LocationNotice(
    text: String,
    background: Color,
    announce: Boolean = false,
) {
    Surface(
        modifier = if (announce) {
            Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                stateDescription = text
            }
        } else {
            Modifier
        },
        color = background,
        shape = MaterialTheme.shapes.small,
    ) {
        Text(
            text,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LocationProgress(message: String) {
    val colors = currentHomeVisualColors()
    Surface(
        modifier = Modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            stateDescription = message
        },
        color = colors.blueSoft,
        shape = MaterialTheme.shapes.small,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun LocationPrivacySummary(location: LocationChoice) {
    val colors = currentHomeVisualColors()
    LocationNotice(
        text = buildString {
            append(if (location.isApproximate) "当前为大致位置" else "当前为系统定位")
            location.coordinate.accuracyMeters?.let { append("，精度约 ${formatAccuracy(it)}") }
            append("。坐标只用于当次推荐，不保存。")
        },
        background = colors.greenSoft,
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
    val colors = currentHomeVisualColors()
    val containerColor by animateColorAsState(
        targetValue = if (selected) colors.accentSoft else colors.cardMuted.copy(alpha = 0.55f),
        animationSpec = tween(HomeMotion.SelectionMillis),
        label = "mode container",
    )
    val borderColor by animateColorAsState(
        targetValue = if (selected) {
            MaterialTheme.colorScheme.primary.copy(alpha = 0.42f)
        } else {
            colors.border
        },
        animationSpec = tween(HomeMotion.SelectionMillis),
        label = "mode border",
    )
    val elevation by animateDpAsState(
        targetValue = if (selected) 2.dp else 0.dp,
        animationSpec = tween(HomeMotion.SelectionMillis),
        label = "mode elevation",
    )
    Card(
        onClick = onClick,
        modifier = modifier
            .heightIn(min = 116.dp)
            .semantics(mergeDescendants = true) {
                this.selected = selected
                role = Role.RadioButton
            },
        colors = CardDefaults.cardColors(containerColor = containerColor),
        border = BorderStroke(1.dp, borderColor),
        elevation = CardDefaults.cardElevation(defaultElevation = elevation),
        shape = RoundedCornerShape(HomeDimens.CompactRadius),
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            HomeIconTile(if (selected) colors.card.copy(alpha = 0.78f) else colors.card) {
                Icon(
                    if (selected) AppIcons.Restaurant else AppIcons.Tune,
                    contentDescription = null,
                    tint = if (selected) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(21.dp),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String, subtitle: String? = null) {
    Column(
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            title,
            modifier = Modifier.semantics { heading() },
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        subtitle?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun <T> OptionSection(
    title: String,
    subtitle: String? = null,
    options: List<Pair<T, String>>,
    selected: T?,
    onSelected: (T) -> Unit,
) {
    HomeCard {
        SectionTitle(title, subtitle)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(options) { (value, label) ->
                FilterChip(
                    selected = value == selected,
                    onClick = { onSelected(value) },
                    label = { Text(label) },
                    leadingIcon = if (value == selected) {
                        { Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
                    } else {
                        null
                    },
                    modifier = Modifier.heightIn(min = 42.dp),
                    shape = RoundedCornerShape(HomeDimens.CompactRadius),
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                        selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    ),
                    border = FilterChipDefaults.filterChipBorder(
                        enabled = true,
                        selected = value == selected,
                        borderColor = MaterialTheme.colorScheme.outlineVariant,
                        selectedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.62f),
                    ),
                )
            }
        }
    }
}

@Composable
private fun PartySizeRow(partySize: Int, onChange: (Int) -> Unit) {
    HomeCard {
        SectionTitle("就餐人数")
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            OutlinedButton(
                onClick = { onChange(partySize - 1) },
                enabled = partySize > 1,
                modifier = Modifier.size(HomeDimens.MinTouchTarget),
                contentPadding = PaddingValues(0.dp),
            ) {
                Icon(
                    AppIcons.Remove,
                    contentDescription = "减少就餐人数",
                    modifier = Modifier.size(22.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "$partySize 人",
                    modifier = Modifier.semantics {
                        liveRegion = LiveRegionMode.Polite
                        stateDescription = "当前 $partySize 人"
                    },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "最多 30 人",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(
                onClick = { onChange(partySize + 1) },
                enabled = partySize < 30,
                modifier = Modifier.size(HomeDimens.MinTouchTarget),
                contentPadding = PaddingValues(0.dp),
            ) {
                Icon(
                    Icons.Rounded.Add,
                    contentDescription = "增加就餐人数",
                    modifier = Modifier.size(22.dp),
                )
            }
        }
    }
}

@Composable
private fun CuisineSection(title: String, selected: Set<String>, onToggle: (String) -> Unit) {
    HomeCard {
        SectionTitle(title)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(cuisines) { cuisine ->
                FilterChip(
                    selected = cuisine in selected,
                    onClick = { onToggle(cuisine) },
                    label = { Text(cuisine) },
                    leadingIcon = if (cuisine in selected) {
                        { Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
                    } else {
                        null
                    },
                    modifier = Modifier.heightIn(min = 42.dp),
                    shape = RoundedCornerShape(HomeDimens.CompactRadius),
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                        selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    ),
                    border = FilterChipDefaults.filterChipBorder(
                        enabled = true,
                        selected = cuisine in selected,
                        borderColor = MaterialTheme.colorScheme.outlineVariant,
                        selectedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.62f),
                    ),
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
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

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val colors = currentHomeVisualColors()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.card,
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        dragHandle = null,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.92f)
                .navigationBarsPadding()
                .imePadding(),
        ) {
            Box(
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(width = 34.dp, height = 4.dp)
                        .background(colors.border, RoundedCornerShape(50)),
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "搜索或选择地点",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "只用于这一轮决定",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onDismiss) { Text("取消") }
            }
            HorizontalDivider(color = colors.border)
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "可输入全国范围内的学校、商圈或地址。输入内容仅用于本次搜索，不保存；结果会明确显示数据来源。",
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
                    modifier = Modifier.fillMaxWidth().heightIn(min = HomeDimens.MinTouchTarget),
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
                Text(
                    "快捷地点（始终可用）",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "以下内置演示地点可在拒绝定位、断网或搜索失败时完成流程，也可搜索全国其他地点。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Surface(
                    color = colors.cardMuted,
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Column {
                        BuiltInQuickLocations.choices.forEachIndexed { index, location ->
                            TextButton(
                                onClick = { onChoose(location) },
                                modifier = Modifier.fillMaxWidth().heightIn(min = HomeDimens.MinTouchTarget),
                            ) {
                                Text(
                                    location.label,
                                    modifier = Modifier.weight(1f),
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                            }
                            if (index != BuiltInQuickLocations.choices.lastIndex) {
                                HorizontalDivider(color = colors.border)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

@Composable
private fun LocationSearchContent(
    state: LocationSearchUiState,
    onChoose: (LocationSearchPlace, LocationSearchDataMode) -> Unit,
) {
    when (state) {
        LocationSearchUiState.Idle -> Unit
        LocationSearchUiState.Loading -> Text(
            "正在搜索地点…",
            modifier = Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                stateDescription = "正在搜索地点"
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        is LocationSearchUiState.Failed -> Text(
            state.message,
            modifier = Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                stateDescription = "地点搜索失败：${state.message}"
            },
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
        )
        is LocationSearchUiState.Empty -> {
            Column(
                modifier = Modifier.semantics {
                    liveRegion = LiveRegionMode.Polite
                    stateDescription = "没有找到匹配地点"
                },
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text("没有找到匹配地点，请换个关键词或使用快捷地点。")
                state.notice?.takeIf(String::isNotBlank)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        is LocationSearchUiState.Ready -> {
            val sourceLabels = state.results.map { it.sourceLabel }.distinct().joinToString("、")
            Text(
                "已找到 ${state.results.size} 个地点",
                modifier = Modifier.semantics {
                    liveRegion = LiveRegionMode.Polite
                    stateDescription = "地点搜索完成，找到 ${state.results.size} 个结果"
                },
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
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

private fun scenarioLabel(scenario: DecisionScenario) = when (scenario) {
    DecisionScenario.IN_A_HURRY -> "赶时间"
    DecisionScenario.WORKDAY_LUNCH -> "工作日午餐"
    DecisionScenario.FRIENDS_GATHERING -> "朋友聚餐"
    DecisionScenario.BUSINESS_TRIP -> "旅行出差"
}
