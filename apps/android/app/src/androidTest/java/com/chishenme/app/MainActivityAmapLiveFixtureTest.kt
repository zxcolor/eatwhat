package com.chishenme.app

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.chishenme.app.data.remote.API_CONTRACT_VERSION
import com.chishenme.app.data.remote.API_CONTRACT_VERSION_HEADER
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.decision.DecisionViewModel
import com.chishenme.app.feature.decision.RecommendationLoadState
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-local presentation test for an AMAP-shaped LIVE_DISPLAY_ONLY response.
 *
 * No AMap Key or provider endpoint is used. The fixture proves only that a response already
 * verified by the server remains labelled, unscored and action-disabled on Android.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityAmapLiveFixtureTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    private lateinit var server: MockWebServer
    private var serverStarted = false
    private val requests = CopyOnWriteArrayList<CapturedRequest>()
    @Volatile
    private var radiusDefaultsEnabled = false
    @Volatile
    private var preferenceRankingEnabled = false
    @Volatile
    private var configurationMinimumVersion = "0.1.1"

    @Before
    fun startDeviceServerAndResetState() {
        assumeTrue(
            "此用例只在显式启用高德设备内展示夹具时运行",
            InstrumentationRegistry.getArguments().getString(OPT_IN_ARGUMENT) == "true",
        )
        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        if (preferencesReset.compareAndSet(false, true)) {
            val preferencesFile = application.preferencesDataStoreFile(PREFERENCES_FILE)
            assertTrue(
                "无法重置高德展示夹具状态：${preferencesFile.absolutePath}",
                !preferencesFile.exists() || preferencesFile.delete(),
            )
        }

        server = MockWebServer().apply { dispatcher = amapDispatcher() }
        try {
            server.start(InetAddress.getByName(DEVICE_LOOPBACK), DEVICE_API_PORT)
            serverStarted = true
        } catch (error: IOException) {
            throw AssertionError(
                "无法在设备 $DEVICE_LOOPBACK:$DEVICE_API_PORT 启动高德展示夹具；" +
                    "运行本用例前必须暂移 adb reverse 并在 finally 中恢复。",
                error,
            )
        }
    }

    @After
    fun stopDeviceServer() {
        if (serverStarted) {
            server.shutdown()
            serverStarted = false
        }
    }

    @Test
    fun homepageDock_keepsLocationAndMovesSettingsToPersonal() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            enterManualLocation(scenario)
            composeRule.onNodeWithText("今天中午吃什么").assertIsDisplayed()
            composeRule.onNodeWithText("What to eat？").assertIsDisplayed()
            composeRule.onNodeWithText("设置").assertDoesNotExist()
            composeRule.onNodeWithText("投票").assertDoesNotExist()
            composeRule.onNodeWithTag("dock-history").performClick().assertIsSelected()
            composeRule.onNodeWithTag("dock-personal").performClick().assertIsSelected()
            composeRule.onNodeWithTag("personal-settings").assertIsDisplayed().performClick()
            awaitText("设置与透明度")
            composeRule.onNodeWithContentDescription("返回").performClick()
            composeRule.onNodeWithTag("personal-conditions").assertIsDisplayed().performClick()
            composeRule.closeHomePanel()
            composeRule.onNodeWithTag("dock-home").assertIsSelected()
            composeRule.onNodeWithText(MANUAL_LOCATION).assertIsDisplayed()
            composeRule.onNodeWithTag("home-decide").assertIsDisplayed()
        }
        assertEquals(setOf("/v1/config"), requests.map { it.path }.toSet())
    }

    @Test
    fun liveAmapResponse_isAttributedUnscoredAndCannotLaunchOutboundActions() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            enterManualLocation(scenario)
            scrollOverviewToTop()
            captureSyntheticScreenshot("home-overview.png")
            composeRule.homeSettingsAction().performClick()
            awaitSettingsConfiguration(enabled = false)
            scrollOverviewToTop()
            composeRule.onNodeWithText("设置与透明度").assertIsDisplayed()
            captureSyntheticScreenshot("settings-overview.png")
            composeRule.onNodeWithContentDescription("返回").performClick()
            assertHomePreferenceControls(enabled = false)
            scrollHomeTo(hasClickAction() and hasText("帮我选"))
                .assertIsDisplayed()
                .performClick()

            awaitResultsReady(scenario)
            scrollOverviewToTop()
            composeRule.onNodeWithText("本次用餐候选").assertIsDisplayed()
            captureSyntheticScreenshot("live-results-overview.png")
            assertFalse("实时展示模式不得声称已替用户选定", hasUiText("这顿就吃它"))
            scrollResultsTo(RESTAURANT_NAME)
            composeRule.onNodeWithText(RESTAURANT_NAME).assertIsDisplayed()
            scrollResultsTo("本次共 1 个候选")
            composeRule.onNodeWithText("本次共 1 个候选").assertIsDisplayed()
            assertFalse("实时展示计数不得称为推荐", hasUiText("本次共 1 条推荐"))
            assertFalse("规则请求不得显示 AI 推荐标记", hasUiText("AI 辅助推荐"))
            scrollResultsTo("高德地图实时数据", substring = true)
            composeRule.onAllNodesWithText("高德地图实时数据", substring = true)[0]
                .assertIsDisplayed()
            assertFalse("实时展示模式不得显示自有适合分", hasUiText("适合 88"))
            scrollResultsTo("为什么")
            composeRule.onNode(hasText("为什么") and hasClickAction())
                .assertIsDisplayed()
                .performClick()
            composeRule.onNodeWithText("保持数据源返回顺序", substring = true)
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText("综合路程", substring = true).assertDoesNotExist()
            captureSyntheticScreenshot("live-results-why.png")
            composeRule.onNodeWithText("知道了").assertIsDisplayed().performClick()

            scrollResultsTo(RESTAURANT_NAME)
            composeRule.onNode(hasClickAction() and hasText(RESTAURANT_NAME, substring = true))
                .assertIsDisplayed()
                .performClick()
            awaitText("餐厅详情")
            captureSyntheticScreenshot("live-detail-overview.png")
            composeRule.onNodeWithText("数据来源：高德地图实时数据")
                .performScrollTo()
                .assertIsDisplayed()
            for (action in listOf("地图查询", "复制地址", "联系商户")) {
                scrollResultsTo(action)
                composeRule.onNodeWithText(action)
                    .performScrollTo()
                    .assertIsDisplayed()
                    .assertIsNotEnabled()
            }
            captureSyntheticScreenshot("live-detail-actions.png")
			composeRule.onNodeWithText(
				"分享推荐卡",
				substring = true,
				useUnmergedTree = true,
			).assertDoesNotExist()
			composeRule.onNodeWithText(
				"分享信息",
				substring = true,
				useUnmergedTree = true,
			).assertDoesNotExist()

            composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) {
                requests.count { it.path == "/v1/recommendation-events" } >= 2
            }
        }

        assertTransportContract()
    }

    @Test
    fun publicRadiusDefaults_showExactOptionsAndRequireExplicitCorrectionBeforeSubmission() {
        radiusDefaultsEnabled = true
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            enterManualLocation(scenario)
            composeRule.openHomeConditions()
            scrollHomeTo(hasText("精细匹配") and hasClickAction()).performClick()
            composeRule.onNode(hasText("精细匹配") and hasClickAction()).assertIsSelected()
            radiusOption("750 m").assertIsSelected()
            radiusOption("1.25 km").assertIsDisplayed()
            captureSyntheticScreenshot("single-radius-750-default.png")

            // Fixed options respect the live upper bound. A user's scenario is
            // still preserved and must be corrected explicitly when it exceeds it.
            scrollHomeTo(hasText("工作日午餐") and hasClickAction()).performClick()
            composeRule.onNode(hasText("工作日午餐") and hasClickAction()).assertIsSelected()
            val error = "当前服务最远支持 1250 米，你选择了 1500 米。请调整最远距离后重试。"
            composeRule.closeHomePanel()
            scrollHomeTo(hasText("帮我选") and hasClickAction()).performClick()
            val submittedRadii = requests.filter { it.path == "/v1/recommendations" }.map {
                Json.parseToJsonElement(it.body).jsonObject.getValue("radiusMeters").jsonPrimitive.content
            }
            assertEquals(
                "距离超限不得发送推荐请求，已发送的半径：$submittedRadii",
                0,
                submittedRadii.size,
            )
            scrollHomeTo(hasText(error)).assertIsDisplayed()
            captureSyntheticScreenshot("single-radius-over-limit.png")
            composeRule.openHomeConditions()
            scrollHomeTo(hasText("精细匹配") and hasClickAction()).performClick()
            radiusOption("1.5 km").assertIsSelected()
            scrollHomeTo(hasText("将最远距离改为 750 米") and hasClickAction()).performClick()
            radiusOption("750 m").assertIsSelected()
            captureSyntheticScreenshot("single-radius-explicit-correction.png")
            composeRule.closeHomePanel()
            scrollHomeTo(hasText("帮我选") and hasClickAction()).performClick()

            awaitResultsReady(scenario)
            scrollResultsTo(RESTAURANT_NAME)
            composeRule.onNode(hasClickAction() and hasText(RESTAURANT_NAME, substring = true))
                .assertIsDisplayed()
                .performClick()
            awaitText("餐厅详情")
            composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) {
                requests.count { it.path == "/v1/recommendation-events" } >= 2
            }
        }
        assertTransportContract(expectedRadiusMeters = 750)
    }

    @Test
    fun liveSettings_hideInactiveControlsAndKeepPreferencesUntilExplicitlyCleared() {
        // The synthetic licensed config is used only to save a preference through
        // the existing UI. No recommendation or external provider is called.
        preferenceRankingEnabled = true
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            enterManualLocation(scenario)
            composeRule.homeSettingsAction().performClick()
            awaitText("设置与透明度")
            awaitSettingsConfiguration(enabled = true)
            scrollSettingsTo("推荐偏好")
            composeRule.onNodeWithContentDescription("质量信号 权重 100%")
                .performScrollTo()
                .assertIsDisplayed()
                .performSemanticsAction(SemanticsActions.SetProgress) { setProgress ->
                    assertTrue(setProgress(40f))
                }
            scrollSettingsTo("存在本机设置").assertIsDisplayed()

            refreshPreferenceRankingCapability(scenario, enabled = false)
            scrollSettingsTo("当前不使用偏好排序，已保存的偏好仍保留在本机。")
                .assertIsDisplayed()
            assertInactivePreferenceControlsAbsent()
            scrollSettingsTo("清除本机偏好").assertIsDisplayed()
            captureSyntheticScreenshot("live-settings-stored-preferences.png")

            // Merely entering LIVE must preserve the user's saved value.
            refreshPreferenceRankingCapability(scenario, enabled = true)
            scrollSettingsTo("推荐偏好")
            composeRule.onNodeWithContentDescription("质量信号 权重 40%")
                .performScrollTo()
                .assertIsDisplayed()
            scrollSettingsTo("存在本机设置").assertIsDisplayed()

            refreshPreferenceRankingCapability(scenario, enabled = false)
            scrollSettingsTo("清除本机偏好").performClick()
            composeRule.waitUntil(UI_TIMEOUT_MS) {
                !hasUiText("推荐偏好") && !hasUiText("清除本机偏好")
            }
            scrollSettingsTo("数据来源").assertIsDisplayed()
            composeRule.onNodeWithText("推荐偏好").assertDoesNotExist()
            composeRule.onNodeWithText("清除本机偏好").assertDoesNotExist()
            assertInactivePreferenceControlsAbsent()
            captureSyntheticScreenshot("live-settings-without-preferences.png")

            // A later licensed config must observe the explicit clear, not a
            // hidden copy of the old value or an automatic reset on mode change.
            refreshPreferenceRankingCapability(scenario, enabled = true)
            scrollSettingsTo("推荐偏好")
            composeRule.onNodeWithContentDescription("质量信号 权重 100%")
                .performScrollTo()
                .assertIsDisplayed()
            scrollSettingsTo("当前使用应用默认值").assertIsDisplayed()
            scrollSettingsTo("清除本机偏好").assertIsNotEnabled()
            composeRule.onNodeWithContentDescription("返回").performClick()
            assertHomePreferenceControls(enabled = true)
        }
        assertEquals(setOf("/v1/config"), requests.map { it.path }.toSet())
        requests.forEach { request ->
            assertEquals(API_CONTRACT_VERSION, request.contractVersion)
            assertNull("本机偏好管理不得发送账号凭据", request.authorization)
        }
    }

    private fun refreshPreferenceRankingCapability(
        scenario: ActivityScenario<MainActivity>,
        enabled: Boolean,
    ) {
        val previousConfigRequests = requests.count { it.path == "/v1/config" }
        preferenceRankingEnabled = enabled
        // Every refresh has a distinct public UI value so a request arrival or
        // a transient Loading presentation cannot be mistaken for the new Ready.
        configurationMinimumVersion = "0.0.${previousConfigRequests + 1}"
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            requests.count { it.path == "/v1/config" } > previousConfigRequests
        }
        awaitSettingsConfiguration(enabled)
    }

    private fun awaitSettingsConfiguration(enabled: Boolean) {
        scrollSettingsTo("版本兼容性")
        awaitText("满足服务端最低兼容版本 $configurationMinimumVersion")
        scrollSettingsTo("推荐规则摘要")
        awaitText(
            if (enabled) {
                "先执行营业、距离、预算和排除项硬规则，再做可解释排序。"
            } else {
                "先执行营业、距离、预算和排除项硬过滤；当前实时展示保持数据源顺序，不生成自有适合度。"
            },
        )
    }

    private fun assertHomePreferenceControls(enabled: Boolean) {
        composeRule.openHomeConditions()
        scrollHomeTo(hasText("精细匹配") and hasClickAction()).performClick()
        for (title in listOf("人均预算", "一共可用多久", "交通方式")) {
            scrollHomeTo(hasText(title)).assertIsDisplayed()
        }
        if (enabled) {
            scrollHomeTo(hasText("探索偏好")).assertIsDisplayed()
        } else {
            composeRule.onNodeWithText("探索偏好").assertDoesNotExist()
        }
        scrollHomeTo(hasText("最远距离")).assertIsDisplayed()
        if (!enabled) composeRule.onNodeWithText("探索偏好").assertDoesNotExist()
        if (enabled) scrollHomeTo(hasText("更想吃")).assertIsDisplayed()
        scrollHomeTo(hasText("这次不吃")).assertIsDisplayed()
        if (!enabled) composeRule.onNodeWithText("更想吃").assertDoesNotExist()
        captureSyntheticScreenshot(if (enabled) "licensed-home-conditions.png" else "live-home-conditions.png")
        scrollHomeTo(hasText("极速决定") and hasClickAction()).performClick()
        val summary = "人均 25元内 · 60 分钟 · 只步行" + if (enabled) " · 平衡选择" else ""
        scrollHomeTo(hasText(summary)).assertIsDisplayed()
        captureSyntheticScreenshot(if (enabled) "licensed-home-summary.png" else "live-home-summary.png")
        composeRule.closeHomePanel()
    }

    private fun scrollSettingsTo(text: String): SemanticsNodeInteraction =
        scrollHomeTo(hasText(text))

    private fun assertInactivePreferenceControlsAbsent() {
        composeRule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .assertCountEquals(0)
        composeRule.onNodeWithText("恢复默认").assertDoesNotExist()
        composeRule.onNodeWithText("可控偏好向量").assertDoesNotExist()
    }

    private fun enterManualLocation(scenario: ActivityScenario<MainActivity>) {
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            hasUiText("同意并继续") || hasUiText("帮我选")
        }
        if (hasUiText("同意并继续")) {
            assertEquals("隐私同意前不得访问配置或地点服务", 0, server.requestCount)
            composeRule.onNodeWithText("同意并继续")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
        }
        lateinit var decisionViewModel: DecisionViewModel
        scenario.onActivity { activity ->
            decisionViewModel = ViewModelProvider(activity)[DecisionViewModel::class.java]
        }
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            requests.any { it.path == "/v1/config" } && hasUiText("帮我选") &&
                decisionViewModel.uiState.value.remoteFeatureConfig is RemoteFeatureConfigState.Ready
        }
        // The configuration notice can cover even the first scrolled location action
        // in a short viewport. Await its actual dismissal before touching the form.
        composeRule.waitForIdle()
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            !hasUiText("已按当前服务建议将最远距离调整为 750 米。")
        }
        composeRule.homeManualLocationAction()
            .assertIsDisplayed()
            .performClick()
        composeRule.onNodeWithText("快捷地点（始终可用）").performScrollTo()
        composeRule.onNodeWithText(MANUAL_LOCATION)
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
    }

    private fun scrollHomeTo(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        val node = composeRule.onNode(matcher)
        // The decision action lives outside the list in the Scaffold bottom bar.
        if (runCatching { node.assertIsDisplayed() }.isSuccess) return node.assertIsDisplayed()
        composeRule.onNode(
            hasScrollToIndexAction() and !hasAnyAncestor(hasScrollToIndexAction()),
        ).performScrollToNode(matcher)
        return composeRule.onNode(matcher).performScrollTo().assertIsDisplayed()
    }

    private fun scrollOverviewToTop() {
        if (hasUiText("帮我选")) return
        composeRule.onNode(
            hasScrollToIndexAction() and !hasAnyAncestor(hasScrollToIndexAction()),
        ).performScrollToIndex(0)
    }

    private fun radiusOption(text: String): SemanticsNodeInteraction {
        scrollHomeTo(hasText("最远距离"))
        val radiusLabels = listOf("500 m", "750 m", "1 km", "1.25 km", "1.5 km", "3 km", "5 km")
            .map { hasText(it) }.reduce { result, next -> result or next }
        composeRule.onNode(
            hasScrollToIndexAction() and hasAnyAncestor(hasScrollToIndexAction()) and
                hasAnyDescendant(radiusLabels),
        ).performScrollToNode(hasText(text))
        composeRule.onNode(
            hasScrollToIndexAction() and !hasAnyAncestor(hasScrollToIndexAction()),
        ).performScrollToNode(hasClickAction() and hasText(text))
        return composeRule.onNode(hasClickAction() and hasText(text))
            .performScrollTo()
            .assertIsDisplayed()
    }

    private fun captureSyntheticScreenshot(fileName: String) {
        composeRule.captureUiRefinementScreenshot(fileName)
    }

    private fun scrollResultsTo(text: String, substring: Boolean = false) {
        val node = composeRule.onNode(hasText(text, substring = substring))
        if (runCatching { node.assertIsDisplayed() }.isSuccess) return
        composeRule.onNode(hasScrollToIndexAction())
            .performScrollToNode(hasText(text, substring = substring))
    }

    private fun awaitText(text: String) {
        composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) { hasUiText(text) }
    }

    private fun awaitResultsReady(scenario: ActivityScenario<MainActivity>) {
        lateinit var decisionViewModel: DecisionViewModel
        scenario.onActivity { activity ->
            decisionViewModel = ViewModelProvider(activity)[DecisionViewModel::class.java]
        }
        composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) {
            hasUiText("本次用餐候选") &&
                decisionViewModel.uiState.value.loadState is RecommendationLoadState.Ready
        }
    }

    private fun hasUiText(text: String): Boolean = composeRule.onAllNodesWithText(
        text = text,
        useUnmergedTree = true,
    ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    private fun assertTransportContract(expectedRadiusMeters: Int = 1_500) {
        requests.forEach { request ->
            assertEquals(API_CONTRACT_VERSION, request.contractVersion)
            assertNull("高德访客展示不得携带账号凭据", request.authorization)
        }
        val recommendation = requests.single { it.path == "/v1/recommendations" }
        val requestBody = Json.parseToJsonElement(recommendation.body).jsonObject
        assertEquals("WGS84", requestBody.getValue("location").jsonObject
            .getValue("crs").jsonPrimitive.content)
        assertEquals(25, requestBody.getValue("budgetMaxYuan").jsonPrimitive.content.toInt())
        assertEquals(expectedRadiusMeters, requestBody.getValue("radiusMeters").jsonPrimitive.content.toInt())
        assertFalse(requestBody.getValue("aiAssistanceEnabled").jsonPrimitive.boolean)

        val events = requests.filter { it.path == "/v1/recommendation-events" }
        assertTrue(events.any { it.body.contains("\"type\":\"IMPRESSION\"") })
        assertTrue(events.any { it.body.contains("\"type\":\"DETAIL\"") })
        assertTrue(events.all { !it.body.contains("providerPlaceId") })
    }

    private fun amapDispatcher(): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl?.encodedPath.orEmpty()
            val body = request.body.readUtf8()
            requests += CapturedRequest(
                method = request.method.orEmpty(),
                path = path,
                authorization = request.getHeader("Authorization"),
                contractVersion = request.getHeader(API_CONTRACT_VERSION_HEADER),
                body = body,
            )
            return when (request.method to path) {
                "GET" to "/v1/config" -> contractResponse(200).setBody(configurationBody())
                "POST" to "/v1/recommendations" -> contractResponse(200).setBody(recommendationBody())
                "POST" to "/v1/recommendation-events" -> contractResponse(204)
                else -> contractResponse(404).setBody("""{"error":"unexpected test request"}""")
            }
        }
    }

    private fun configurationBody(): String = """
        {
          "coverageName":"全国服务",
          ${if (radiusDefaultsEnabled) """
          "recommendationDefaults":{
            "areaCode":"NATIONWIDE","defaultRadiusMeters":750,"maximumRadiusMeters":1250
          },
          """.trimIndent() else ""}
          "dataRightsMode":"${if (preferenceRankingEnabled) "LICENSED_ENRICHMENT" else "LIVE_DISPLAY_ONLY"}",
          "aiEnabled":false,
          "accountsEnabled":false,
          "favoritesEnabled":false,
          "supportFeedbackEnabled":false,
          "minimumSupportedVersion":"$configurationMinimumVersion",
          "ruleVersion":"rule-amap-device-fixture-v1",
          "promptVersion":"prompt-disabled",
          "modelVersion":"rule-amap-device-fixture-v1",
          "serviceCapabilities":{
            "recommendationsEnabled":true,
            "locationSearchEnabled":true,
            "placeSearchEnabled":true
          }
        }
    """.trimIndent()

    private fun recommendationBody(): String = """
        {
          "requestId":"50000000-0000-4000-8000-000000000001",
          "generatedAt":"2026-08-22T00:00:00Z",
          "coverage":"NATIONWIDE",
          "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "ruleVersion":"rule-amap-device-fixture-v1",
          "promptVersion":"prompt-disabled",
          "modelVersion":"rule-amap-device-fixture-v1",
          "aiFallbackUsed":false,
          "results":[{
            "provider":"AMAP",
            "resultToken":"EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
            "dataMode":"LIVE",
            "actions":{"navigate":false,"call":false,"copyAddress":false,"share":false},
            "name":"$RESTAURANT_NAME",
            "address":"北京市海淀区设备内契约测试路 1 号",
            "rank":1,
            "fitScore":null,
            "sourceRating":4.5,
            "averageCostYuan":25.0,
            "distanceMeters":180.0,
            "estimatedTravelMinutes":4.0,
            "estimatedMealMinutes":25.0,
            "openStatus":"UNKNOWN",
            "tags":["餐饮服务"],
            "imageUrl":null,
            "phone":null,
            "location":{"latitude":39.9942,"longitude":116.3161,"accuracyMeters":null,"crs":"GCJ02"},
            "reasons":[{"code":"DISTANCE_FIT","text":"距离符合当前请求范围"}],
            "warnings":["设备内合成契约数据，不代表真实餐厅或高德联网结果"],
            "confidence":"MEDIUM",
            "aiAssisted":false,
            "sourceAttribution":"高德地图实时数据"
          }],
          "notice":"本用例仅验证高德实时响应在 Android 的展示边界，不保存外部餐厅数据。"
        }
    """.trimIndent()

    private fun contractResponse(statusCode: Int): MockResponse = MockResponse()
        .setResponseCode(statusCode)
        .setHeader(API_CONTRACT_VERSION_HEADER, API_CONTRACT_VERSION)
        .setHeader("Content-Type", "application/json; charset=utf-8")

    private data class CapturedRequest(
        val method: String,
        val path: String,
        val authorization: String?,
        val contractVersion: String?,
        val body: String,
    )

    private companion object {
        const val OPT_IN_ARGUMENT = "amapLiveFixture"
        const val DEVICE_LOOPBACK = "127.0.0.1"
        const val DEVICE_API_PORT = 3001
        const val PREFERENCES_FILE = "app_preferences.preferences_pb"
        const val UI_TIMEOUT_MS = 20_000L
        const val MANUAL_LOCATION = "北京大学东门"
        const val RESTAURANT_NAME = "设备内高德契约餐厅（合成）"
        val preferencesReset = AtomicBoolean(false)
    }
}
