package com.chishenme.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.chishenme.app.data.remote.API_CONTRACT_VERSION
import com.chishenme.app.data.remote.API_CONTRACT_VERSION_HEADER
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.ReasonCode
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import com.chishenme.app.feature.decision.DecisionViewModel
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import kotlinx.serialization.encodeToString
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
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-local acceptance test for the fail-closed guest recommendation path.
 *
 * This class is opt-in because MockWebServer owns the same device port normally
 * occupied by `adb reverse tcp:3001 tcp:3001`. The production Hilt graph and
 * debug base URL remain untouched: the test only replaces the process listening
 * at 127.0.0.1:3001.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityConfigUnavailableTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    private lateinit var server: MockWebServer
    private var serverStarted = false

    @Before
    fun startDeviceServerAndResetFirstLaunch() {
        assumeTrue(
            "此用例只在显式启用远程配置不可用测试环境时运行",
            InstrumentationRegistry.getArguments().getString(OPT_IN_ARGUMENT) == "true",
        )

        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        val preferencesFile = application.preferencesDataStoreFile(
            "app_preferences.preferences_pb",
        )
        assertTrue(
            "无法重置首次启动状态：${preferencesFile.absolutePath}",
            !preferencesFile.exists() || preferencesFile.delete(),
        )

        server = MockWebServer().apply { dispatcher = fallbackDispatcher() }
        try {
            server.start(InetAddress.getByName(DEVICE_LOOPBACK), DEVICE_API_PORT)
            serverStarted = true
        } catch (error: IOException) {
            throw AssertionError(
                "无法在设备 $DEVICE_LOOPBACK:$DEVICE_API_PORT 启动 MockWebServer；" +
                    "运行本专用用例前请暂移 adb reverse tcp:$DEVICE_API_PORT，" +
                    "并在 finally 中恢复原映射。",
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
    fun firstLaunch_config503_usesDisplayOnlyRulesAcrossActivityRecreation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var decisionViewModel: DecisionViewModel
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasUiText(PRIVACY_ACCEPT_ACTION)
            }
            composeRule.onNodeWithText(PRIVACY_ACCEPT_ACTION).assertIsDisplayed()
            assertEquals("隐私同意前不应访问任何接口", 0, server.requestCount)
            composeRule.onNodeWithText(PRIVACY_ACCEPT_ACTION).performClick()

            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                hasUiText(CONFIG_UNAVAILABLE_MESSAGE)
            }
            composeRule.onNodeWithText(CONFIG_UNAVAILABLE_MESSAGE).assertIsDisplayed()
            scenario.onActivity { activity ->
                decisionViewModel = ViewModelProvider(activity)[DecisionViewModel::class.java]
            }
            val unavailable = decisionViewModel.uiState.value.remoteFeatureConfig
                as? RemoteFeatureConfigState.Unavailable
                ?: failWithDecisionDiagnostics(
                    prefix = "配置 503 已显示，但 DecisionViewModel 未进入 Unavailable",
                    viewModel = decisionViewModel,
                )
            val gate = decisionViewModel.runtimeAppVersionGate.currentState
            assertEquals(RuntimeAppVersionGate.Status.UNKNOWN, gate.status)
            assertEquals(unavailable.generation, gate.observedConfigurationGeneration)
            assertTrue("配置不可用时应开放规则展示 lease", gate.failClosedGuestDecisionAllowed)
            val guestLease = decisionViewModel.runtimeAppVersionGate
                .acquireRecommendationAccessLease(unavailable.generation)
            assertTrue("配置不可用 generation 应能取得访客规则推荐 lease", guestLease != null)
            // This message is rendered by the Scaffold SnackbarHost at the bottom
            // of Home. Waiting for it to leave prevents a synthetic tap aimed at
            // the bottom decision button from landing on the transient overlay.
            composeRule.waitUntil(timeoutMillis = SNACKBAR_DISMISS_TIMEOUT_MS) {
                !hasUiText(CONFIG_UNAVAILABLE_MESSAGE)
            }
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasUiText("手动选择")
            }
            composeRule.onNodeWithText("手动选择").assertIsDisplayed().performClick()
            composeRule.onNodeWithText("快捷地点（始终可用）")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText(MANUAL_LOCATION)
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.onNodeWithText(MANUAL_LOCATION).assertIsDisplayed()
            assertEquals(
                "UI 点击快捷地点后应同步写入同一 DecisionViewModel",
                MANUAL_LOCATION,
                decisionViewModel.uiState.value.input.location?.label,
            )
            composeRule.onNode(hasText("帮我决定") and hasClickAction())
                .performScrollTo()
                .assertIsDisplayed()
                .assertIsEnabled()
                .performClick()

            val reachedRecommendationScreen = runCatching {
                composeRule.waitUntil(timeoutMillis = RECOMMENDATION_TIMEOUT_MS) {
                    hasUiText("推荐结果") || hasUiText("这次没决定出来")
                }
            }.isSuccess
            if (!reachedRecommendationScreen) {
                failWithDecisionDiagnostics(
                    prefix = "点击帮我决定后未进入推荐结果或失败页；server.requestCount=${server.requestCount}",
                    viewModel = decisionViewModel,
                )
            }
            if (hasUiText("这次没决定出来")) {
                fail("配置不可用时未得到规则推荐；结果页进入失败状态")
            }

            assertDisplayOnlyResult()
            scrollResultsListTo("为什么")
            composeRule.onNode(hasText("为什么") and hasClickAction())
                .assertIsDisplayed()
                .performClick()
            composeRule.onNodeWithText(LIVE_DISPLAY_ONLY_EXPLANATION).assertIsDisplayed()
            composeRule.onNodeWithText("模型 rule-device-fallback-v1", substring = true)
                .assertIsDisplayed()
            composeRule.onNodeWithText("知道了").assertIsDisplayed().performClick()

            val configRequest = takeRequiredRequest("远程配置")
            assertRequest(configRequest, "GET", "/v1/config")
            val recommendationRequest = takeRequiredRequest("规则推荐")
            assertRequest(recommendationRequest, "POST", "/v1/recommendations")
            val recommendationJson = Json.parseToJsonElement(
                recommendationRequest.body.readUtf8(),
            ).jsonObject
            assertFalse(
                "配置不可用时请求必须显式关闭 AI 辅助",
                recommendationJson.getValue("aiAssistanceEnabled").jsonPrimitive.boolean,
            )

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasUiText("推荐结果") || hasUiText(RECOMMENDATION_EXPIRED_MARKER)
            }
            if (hasUiText(RECOMMENDATION_EXPIRED_MARKER)) {
                fail("Activity 重建后配置不可用的展示态推荐意外失效")
            }
            assertDisplayOnlyResult()

            assertNull(
                "配置不可用会话不得发送推荐事件或访问其他接口",
                server.takeRequest(NO_EXTRA_REQUEST_WINDOW_MS, TimeUnit.MILLISECONDS),
            )
            assertEquals("服务端只应收到配置与推荐两个请求", 2, server.requestCount)
        }
    }

    private fun assertDisplayOnlyResult() {
        scrollResultsListTo("推荐结果")
        composeRule.onNodeWithText("推荐结果").assertIsDisplayed()
        scrollResultsListTo(GUEST_RULES_ONLY_NOTICE)
        composeRule.onNodeWithText(GUEST_RULES_ONLY_NOTICE)
            .assertIsDisplayed()
        scrollResultsListTo(FALLBACK_RESTAURANT_NAME)
        composeRule.onNodeWithText(FALLBACK_RESTAURANT_NAME)
            .assertIsDisplayed()
        scrollResultsListTo("仅展示，详情与操作暂不可用")
        composeRule.onNodeWithText("仅展示，详情与操作暂不可用")
            .assertIsDisplayed()
        scrollResultsListTo("虚构演示数据", substring = true)
        composeRule.onAllNodesWithText("虚构演示数据", substring = true)[0]
            .assertIsDisplayed()
        assertFalse("规则回退不得显示 AI 辅助标记", hasUiText("AI 辅助推荐"))
        composeRule.onNode(
            hasClickAction() and androidx.compose.ui.test.hasText(
                FALLBACK_RESTAURANT_NAME,
                substring = true,
            ),
        ).assertDoesNotExist()
        BLOCKED_DETAIL_AND_OUTBOUND_ACTIONS.forEach { action ->
            composeRule.onNodeWithText(action).assertDoesNotExist()
        }
        scrollResultsListTo(SAME_CONDITIONS_RETRY_ACTION)
        composeRule.onNode(hasText(SAME_CONDITIONS_RETRY_ACTION) and hasClickAction())
            .assertIsDisplayed()
            .assertIsEnabled()
        scrollResultsListTo(ADJUST_CONDITIONS_ACTION)
        composeRule.onNode(hasText(ADJUST_CONDITIONS_ACTION) and hasClickAction())
            .assertIsDisplayed()
            .assertIsEnabled()
    }

    private fun scrollResultsListTo(text: String, substring: Boolean = false) {
        composeRule.onNode(hasScrollToIndexAction())
            .performScrollToNode(hasText(text, substring = substring))
    }

    private fun assertRequest(
        request: RecordedRequest,
        expectedMethod: String,
        expectedPath: String,
    ) {
        assertEquals(expectedMethod, request.method)
        assertEquals(expectedPath, request.requestUrl?.encodedPath)
        assertEquals(
            API_CONTRACT_VERSION,
            request.getHeader(API_CONTRACT_VERSION_HEADER),
        )
        assertNull("访客规则推荐不得携带登录凭据", request.getHeader("Authorization"))
    }

    private fun takeRequiredRequest(label: String): RecordedRequest =
        server.takeRequest(REQUEST_CAPTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            ?: throw AssertionError("未收到预期的${label}请求")

    private fun failWithDecisionDiagnostics(
        prefix: String,
        viewModel: DecisionViewModel,
    ): Nothing {
        val state = viewModel.uiState.value
        val gate = viewModel.runtimeAppVersionGate.currentState
        fail(
            "$prefix；remoteFeatureConfig=${state.remoteFeatureConfig}；" +
                "gateStatus=${gate.status}；" +
                "gateObservedGeneration=${gate.observedConfigurationGeneration}；" +
                "gateTrustedGeneration=${gate.trustedConfigurationGeneration}；" +
                "guestAllowed=${gate.failClosedGuestDecisionAllowed}；" +
                "location=${state.input.location?.label}；" +
                "formError=${state.formError}；loadState=${state.loadState}",
        )
        error("unreachable")
    }

    private fun recreateActivity(scenario: ActivityScenario<MainActivity>) {
        lateinit var previous: MainActivity
        scenario.onActivity { activity -> previous = activity }
        scenario.recreate()
        scenario.onActivity { recreated ->
            assertTrue(
                "ActivityScenario.recreate() 未创建新的 MainActivity 实例",
                recreated !== previous,
            )
        }
    }

    private fun hasUiText(text: String, substring: Boolean = false): Boolean =
        composeRule.onAllNodesWithText(
            text = text,
            substring = substring,
            useUnmergedTree = true,
        ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    private fun fallbackDispatcher(): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse = when (
            request.method to request.requestUrl?.encodedPath
        ) {
            "GET" to "/v1/config" -> contractResponse(503)
                .setBody("""{"error":"configuration temporarily unavailable"}""")
            "POST" to "/v1/recommendations" -> contractResponse(200)
                .setBody(Json.encodeToString(fallbackResponse()))
            else -> contractResponse(404)
                .setBody("""{"error":"unexpected test request"}""")
        }
    }

    private fun contractResponse(statusCode: Int): MockResponse = MockResponse()
        .setResponseCode(statusCode)
        .setHeader(API_CONTRACT_VERSION_HEADER, API_CONTRACT_VERSION)
        .setHeader("Content-Type", "application/json; charset=utf-8")

    private fun fallbackResponse(): RecommendationResponse = RecommendationResponse(
        requestId = "2f87007b-a417-4e3c-9adf-bf70011eca37",
        generatedAt = "2026-08-21T00:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-device-fallback-v1",
        promptVersion = "prompt-disabled",
        modelVersion = "rule-device-fallback-v1",
        aiFallbackUsed = false,
        results = listOf(
            RecommendationResult(
                provider = "DEMO",
                resultToken = "A".repeat(43),
                dataMode = RecommendationDataMode.DEMO,
                // Deliberately permissive: the untrusted guest lease must still
                // suppress details and all outbound actions on the client.
                actions = RecommendationActions(
                    navigate = true,
                    call = true,
                    copyAddress = true,
                    share = true,
                ),
                name = FALLBACK_RESTAURANT_NAME,
                address = "北京市海淀区设备内演示地址 1 号",
                rank = 1,
                fitScore = null,
                sourceRating = 4.6,
                averageCostYuan = 20.0,
                distanceMeters = 320.0,
                estimatedTravelMinutes = 6.0,
                estimatedMealMinutes = 25.0,
                openStatus = OpenStatus.OPEN,
                tags = listOf("中式快餐"),
                imageUrl = null,
                phone = "010-55551234",
                location = Coordinate(
                    latitude = 39.9940,
                    longitude = 116.3120,
                    accuracyMeters = 30.0,
                    crs = CoordinateReferenceSystem.WGS84,
                ),
                reasons = listOf(
                    RecommendationReason(
                        code = ReasonCode.TIME_FIT,
                        text = "路程与用餐时间符合当前条件",
                    ),
                ),
                warnings = listOf("设备内虚构数据，仅用于回退验收"),
                confidence = Confidence.MEDIUM,
                aiAssisted = false,
                sourceAttribution = "虚构演示数据",
            ),
        ),
        notice = null,
    )

    companion object {
        private const val OPT_IN_ARGUMENT = "configUnavailable"
        private const val DEVICE_LOOPBACK = "127.0.0.1"
        private const val DEVICE_API_PORT = 3001
        private const val STARTUP_TIMEOUT_MS = 10_000L
        private const val CONFIG_TIMEOUT_MS = 20_000L
        private const val SNACKBAR_DISMISS_TIMEOUT_MS = 10_000L
        private const val RECOMMENDATION_TIMEOUT_MS = 20_000L
        private const val REQUEST_CAPTURE_TIMEOUT_MS = 5_000L
        private const val NO_EXTRA_REQUEST_WINDOW_MS = 1_500L
        private const val PRIVACY_ACCEPT_ACTION = "同意并继续"
        private const val CONFIG_UNAVAILABLE_MESSAGE =
            "远程配置暂不可用，AI 已按安全默认值关闭"
        private const val MANUAL_LOCATION = "北京大学东门"
        private const val FALLBACK_RESTAURANT_NAME = "设备内规则饭堂（虚构）"
        private const val RECOMMENDATION_EXPIRED_MARKER = "推荐状态已失效"
        private const val LIVE_DISPLAY_ONLY_EXPLANATION =
            "当前为实时展示模式，未取得数据增强授权，因此不展示自有适合度。"
        private const val GUEST_RULES_ONLY_NOTICE =
            "远程配置暂不可用：本次仅展示不含 AI 的规则推荐。为保护数据，餐厅详情、导航、电话、复制地址及推荐事件均已关闭；仍可按相同条件重新请求，结果可能相同。"
        private const val SAME_CONDITIONS_RETRY_ACTION = "按相同条件重新请求"
        private const val ADJUST_CONDITIONS_ACTION = "返回调整条件"
        private val BLOCKED_DETAIL_AND_OUTBOUND_ACTIONS = listOf(
            "餐厅详情",
            "地图查询",
            "复制地址",
            "联系商户",
            "分享推荐卡",
        )
    }
}
