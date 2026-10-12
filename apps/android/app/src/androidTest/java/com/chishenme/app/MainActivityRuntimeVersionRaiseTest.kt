package com.chishenme.app

import android.os.SystemClock
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
import com.chishenme.app.feature.decision.RecommendationLoadState
import com.chishenme.app.feature.session.ResultSessionState
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
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
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-local acceptance test for a minimum-version raise in a live process.
 *
 * The first recommendation response is deliberately held by MockWebServer while
 * the same Activity and ViewModel pass through ON_STOP/ON_START. The foreground
 * configuration refresh raises the minimum version, then later rechecks prove
 * both sticky locking and safe same-process recovery. No production dependency
 * is replaced and no external API key or host backend is used.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityRuntimeVersionRaiseTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    private lateinit var server: MockWebServer
    private var serverStarted = false
    private val configCallCount = AtomicInteger(0)
    private val recommendationCallCount = AtomicInteger(0)
    private val eventCallCount = AtomicInteger(0)
    private val firstRecommendationStarted = CountDownLatch(1)
    private val releaseOldRecommendationResponse = CountDownLatch(1)
    private val oldRecommendationResponseReturned = CountDownLatch(1)
    private val recommendationBodies = CopyOnWriteArrayList<String>()
    private val eventBodies = CopyOnWriteArrayList<String>()
    private val contractViolations = CopyOnWriteArrayList<String>()
    private val unexpectedRequests = CopyOnWriteArrayList<String>()

    @Before
    fun startDeviceServerAndResetFirstLaunch() {
        assumeTrue(
            "此用例只在显式启用运行中最低版本提高测试环境时运行",
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

        server = MockWebServer().apply { dispatcher = runtimeVersionDispatcher() }
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
        // Never leave a dispatcher thread blocked when an earlier assertion fails.
        releaseOldRecommendationResponse.countDown()
        if (serverStarted) {
            server.shutdown()
            serverStarted = false
        }
    }

    @Test
    fun liveCompatibleProcess_versionRaiseRevokesLateResultAndRecoversSafely() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var originalActivity: MainActivity
            lateinit var decisionViewModel: DecisionViewModel

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasUiText(PRIVACY_ACCEPT_ACTION)
            }
            composeRule.onNodeWithText(PRIVACY_ACCEPT_ACTION).assertIsDisplayed()
            assertEquals("隐私同意前不应访问任何接口", 0, server.requestCount)
            composeRule.onNodeWithText(PRIVACY_ACCEPT_ACTION).performClick()

            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                configCallCount.get() == 1 && hasUiText("帮我选")
            }
            scenario.onActivity { activity ->
                originalActivity = activity
                decisionViewModel = ViewModelProvider(activity)[DecisionViewModel::class.java]
            }
            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                decisionViewModel.runtimeAppVersionGate.currentState.status ==
                    RuntimeAppVersionGate.Status.COMPATIBLE
            }
            val initialCompatibleGeneration = assertCompatibleConfiguration(decisionViewModel)

            selectManualLocationAndStartRecommendation(decisionViewModel)
            assertTrue(
                "服务端未确认第一条推荐已在途",
                firstRecommendationStarted.await(REQUEST_CAPTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS),
            )
            assertEquals(1, recommendationCallCount.get())
            assertTrue(
                "第一条推荐进入服务端等待后，客户端应保持 Loading",
                decisionViewModel.uiState.value.loadState is RecommendationLoadState.Loading,
            )

            // ActivityScenario CREATED emits ON_STOP and RESUMED emits ON_START.
            // The same instances must survive, otherwise this would only prove a
            // cold-start gate rather than a live-process foreground refresh.
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            scenario.onActivity { resumed ->
                assertSame("ON_STOP/ON_START 不应重建 MainActivity", originalActivity, resumed)
                assertSame(
                    "运行中最低版本提高必须由同一个 DecisionViewModel 观察",
                    decisionViewModel,
                    ViewModelProvider(resumed)[DecisionViewModel::class.java],
                )
            }

            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                configCallCount.get() >= 2 &&
                    decisionViewModel.runtimeAppVersionGate.currentState.status ==
                    RuntimeAppVersionGate.Status.UPDATE_REQUIRED &&
                    hasUiText(UPDATE_HEADING)
            }
            val firstHighGeneration = assertUpdateOnlySurface(decisionViewModel)
            assertTrue(
                "运行中高最低版本配置必须推进进程级配置代际",
                firstHighGeneration > initialCompatibleGeneration,
            )

            releaseOldRecommendationResponse.countDown()
            assertTrue(
                "服务端未释放旧推荐响应",
                oldRecommendationResponseReturned.await(
                    REQUEST_CAPTURE_TIMEOUT_MS,
                    TimeUnit.MILLISECONDS,
                ),
            )
            // The latch proves the server-side dispatcher returned the old
            // response. A canceled Retrofit call need not consume that body, so
            // observe the client state throughout a bounded stability window
            // instead of claiming transport delivery from a fixed sleep.
            assertLateRecommendationStaysRevokedForWindow(decisionViewModel)

            // A failed recheck advances the observed generation but must keep
            // the already-confirmed update requirement sticky and must not open
            // the guest fallback that is valid only before an update lock.
            composeRule.onNodeWithText(RECHECK_ACTION).assertIsDisplayed().performClick()
            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                val gate = decisionViewModel.runtimeAppVersionGate.currentState
                configCallCount.get() >= 3 &&
                    gate.status == RuntimeAppVersionGate.Status.UPDATE_REQUIRED &&
                    gate.observedConfigurationGeneration != firstHighGeneration &&
                    gate.trustedConfigurationGeneration == null &&
                    decisionViewModel.uiState.value.remoteFeatureConfig is
                    RemoteFeatureConfigState.Unavailable
            }
            val unavailableGeneration = assertUnavailableRefreshStaysUpdateLocked(
                decisionViewModel,
            )
            assertTrue(
                "失败复查必须推进 observed 配置代际",
                unavailableGeneration > firstHighGeneration,
            )
            assertLateRecommendationStayedRevoked(decisionViewModel)

            // The next explicitly trusted compatible response unlocks this same
            // process, but it must not restore the old recommendation session.
            composeRule.onNodeWithText(RECHECK_ACTION).assertIsDisplayed().performClick()
            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                configCallCount.get() >= 4 &&
                    decisionViewModel.runtimeAppVersionGate.currentState.status ==
                    RuntimeAppVersionGate.Status.COMPATIBLE &&
                    hasUiText("帮我选")
            }
            val recoveredCompatibleGeneration = assertCompatibleConfiguration(decisionViewModel)
            assertTrue(
                "恢复兼容配置必须使用比失败复查更新的代际",
                recoveredCompatibleGeneration > unavailableGeneration,
            )
            assertEquals(
                "解锁后旧结果 token 仍必须失效",
                ResultSessionState.EXPIRED,
                decisionViewModel.recommendationSessionState(OLD_RESULT_TOKEN),
            )
            assertTrue(
                "兼容配置解锁后不应自动恢复旧推荐",
                decisionViewModel.uiState.value.loadState is RecommendationLoadState.Idle,
            )
            assertEquals("解锁前旧结果不得产生曝光事件", 0, eventCallCount.get())
            assertNull(
                "可信兼容配置必须清除旧版本门禁 Snackbar 消息",
                decisionViewModel.uiState.value.transientMessage,
            )
            assertNull(
                "可信兼容配置必须清除旧版本门禁表单错误",
                decisionViewModel.uiState.value.formError,
            )
            composeRule.onNodeWithText(REQUIRED_UPDATE_MESSAGE).assertDoesNotExist()
            composeRule.onNodeWithText(OLD_RESTAURANT_NAME).assertDoesNotExist()
            composeRule.onNodeWithText("本次用餐候选").assertDoesNotExist()
            assertEquals(
                "配置刷新应保留安全的表单地点，供用户显式重新提交",
                MANUAL_LOCATION,
                decisionViewModel.uiState.value.input.location?.label,
            )

            composeRule.onNode(hasText("帮我选") and hasClickAction())
                .assertIsDisplayed()
                .assertIsEnabled()
                .performClick()
            val reachedNewRecommendation = runCatching {
                composeRule.waitUntil(timeoutMillis = RECOMMENDATION_TIMEOUT_MS) {
                    hasUiText(NEW_RESTAURANT_NAME) || hasUiText("这次没决定出来")
                }
            }.isSuccess
            if (!reachedNewRecommendation) {
                failWithDecisionDiagnostics(
                    prefix = "兼容配置解锁后点击帮我选未产生结果；" +
                        "server.requestCount=${server.requestCount}",
                    viewModel = decisionViewModel,
                )
            }
            if (hasUiText("这次没决定出来")) {
                failWithDecisionDiagnostics(
                    prefix = "兼容配置解锁后的显式新推荐失败",
                    viewModel = decisionViewModel,
                )
            }
            composeRule.onNodeWithText("本次用餐候选").assertIsDisplayed()
            composeRule.onNodeWithText(NEW_RESTAURANT_NAME)
                .performScrollTo()
                .assertIsDisplayed()

            composeRule.waitUntil(timeoutMillis = EVENT_TIMEOUT_MS) {
                eventCallCount.get() == 1 && eventBodies.size == 1
            }
            val ready = decisionViewModel.uiState.value.loadState as? RecommendationLoadState.Ready
                ?: failWithDecisionDiagnostics(
                    prefix = "新推荐已显示但 ViewModel 未进入 Ready",
                    viewModel = decisionViewModel,
                )
            assertEquals(NEW_REQUEST_ID, ready.response.requestId)
            assertEquals(NEW_RESULT_TOKEN, ready.response.results.single().resultToken)
            assertEquals(
                ResultSessionState.CURRENT,
                decisionViewModel.recommendationSessionState(NEW_RESULT_TOKEN),
            )
            assertNewRecommendationOwnsTheOnlyEvent()
            assertBothRecommendationRequestsDisableAi()

            assertEquals("配置请求序列应为兼容、高、503、兼容", 4, configCallCount.get())
            assertEquals("只应有旧、新两次推荐请求", 2, recommendationCallCount.get())
            assertEquals("只有新推荐可以产生一次曝光事件", 1, eventCallCount.get())
            assertEquals("设备夹具应只收到七个预期请求", 7, server.requestCount)
            assertTrue(
                "所有请求都必须携带当前 API 契约头且不得携带访客凭据：$contractViolations",
                contractViolations.isEmpty(),
            )
            assertTrue(
                "设备夹具收到未声明接口：$unexpectedRequests",
                unexpectedRequests.isEmpty(),
            )
        }
    }

    private fun selectManualLocationAndStartRecommendation(viewModel: DecisionViewModel) {
        composeRule.homeManualLocationAction().assertIsDisplayed().performClick()
        composeRule.onNodeWithText("快捷地点（始终可用）")
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithText(MANUAL_LOCATION)
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        assertEquals(MANUAL_LOCATION, viewModel.uiState.value.input.location?.label)
        composeRule.onNode(hasText("帮我选") and hasClickAction())
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()
    }

    private fun assertCompatibleConfiguration(viewModel: DecisionViewModel): Long {
        val gate = viewModel.runtimeAppVersionGate.currentState
        assertEquals(RuntimeAppVersionGate.Status.COMPATIBLE, gate.status)
        assertEquals(COMPATIBLE_MINIMUM_VERSION, gate.minimumSupportedVersion)
        assertEquals(gate.observedConfigurationGeneration, gate.trustedConfigurationGeneration)
        val compatibleGeneration = requireNotNull(gate.observedConfigurationGeneration)
        val remote = viewModel.uiState.value.remoteFeatureConfig as? RemoteFeatureConfigState.Ready
            ?: failWithDecisionDiagnostics(
                prefix = "可信兼容配置没有进入 Ready",
                viewModel = viewModel,
            )
        assertEquals(compatibleGeneration, remote.generation)
        assertEquals(COMPATIBLE_MINIMUM_VERSION, remote.config.minimumSupportedVersion)
        return compatibleGeneration
    }

    private fun assertUpdateOnlySurface(viewModel: DecisionViewModel): Long {
        assertUpdateOnlyUiAndGate(viewModel)
        val gate = viewModel.runtimeAppVersionGate.currentState
        assertEquals(gate.observedConfigurationGeneration, gate.trustedConfigurationGeneration)
        val generation = requireNotNull(gate.observedConfigurationGeneration)
        val remote = viewModel.uiState.value.remoteFeatureConfig as? RemoteFeatureConfigState.Ready
            ?: failWithDecisionDiagnostics(
                prefix = "高最低版本可信配置没有进入 Ready",
                viewModel = viewModel,
            )
        assertEquals(generation, remote.generation)
        assertEquals(HIGH_MINIMUM_VERSION, remote.config.minimumSupportedVersion)
        return generation
    }

    private fun assertUnavailableRefreshStaysUpdateLocked(viewModel: DecisionViewModel): Long {
        assertUpdateOnlyUiAndGate(viewModel)
        val gate = viewModel.runtimeAppVersionGate.currentState
        assertNull("失败复查不得保留 trusted 配置代际", gate.trustedConfigurationGeneration)
        assertFalse("更新锁定后配置失败不得开放 guest 推荐", gate.failClosedGuestDecisionAllowed)
        val generation = requireNotNull(gate.observedConfigurationGeneration)
        val remote = viewModel.uiState.value.remoteFeatureConfig
            as? RemoteFeatureConfigState.Unavailable
            ?: failWithDecisionDiagnostics(
                prefix = "503 复查没有进入 Unavailable",
                viewModel = viewModel,
            )
        assertEquals(generation, remote.generation)
        assertEquals(REQUIRED_UPDATE_MESSAGE, viewModel.uiState.value.transientMessage)
        assertEquals(REQUIRED_UPDATE_MESSAGE, viewModel.uiState.value.formError)
        return generation
    }

    private fun assertUpdateOnlyUiAndGate(viewModel: DecisionViewModel) {
        composeRule.onNodeWithText(UPDATE_HEADING).assertIsDisplayed()
        composeRule.onNodeWithText("当前版本：", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("最低支持版本：$HIGH_MINIMUM_VERSION").assertIsDisplayed()
        composeRule.onNodeWithText(RECHECK_ACTION).assertIsDisplayed()
        composeRule.onNodeWithText("撤回隐私同意").assertIsDisplayed()
        composeRule.onNodeWithText("数据权利").assertIsDisplayed()
        REMOTE_PRODUCT_TEXTS.forEach { text ->
            assertFalse("更新专页不应包含远程入口：$text", hasUiText(text))
        }

        val gate = viewModel.runtimeAppVersionGate.currentState
        assertEquals(RuntimeAppVersionGate.Status.UPDATE_REQUIRED, gate.status)
        assertEquals(HIGH_MINIMUM_VERSION, gate.minimumSupportedVersion)
    }

    private fun assertLateRecommendationStayedRevoked(viewModel: DecisionViewModel) {
        assertTrue(
            "旧推荐响应不得把更新锁定态改回结果态",
            viewModel.uiState.value.loadState is RecommendationLoadState.Idle,
        )
        assertEquals(
            "最低版本提高后旧 token 必须失效",
            ResultSessionState.EXPIRED,
            viewModel.recommendationSessionState(OLD_RESULT_TOKEN),
        )
        assertEquals("旧推荐不得产生自动曝光事件", 0, eventCallCount.get())
        composeRule.onNodeWithText(UPDATE_HEADING).assertIsDisplayed()
        composeRule.onNodeWithText("本次用餐候选").assertDoesNotExist()
        composeRule.onNodeWithText(OLD_RESTAURANT_NAME).assertDoesNotExist()
    }

    private fun assertLateRecommendationStaysRevokedForWindow(viewModel: DecisionViewModel) {
        val deadline = SystemClock.uptimeMillis() + LATE_RESPONSE_STABILITY_WINDOW_MS
        do {
            val stayedIdle = viewModel.uiState.value.loadState is RecommendationLoadState.Idle
            val oldTokenExpired =
                viewModel.recommendationSessionState(OLD_RESULT_TOKEN) == ResultSessionState.EXPIRED
            if (!stayedIdle || !oldTokenExpired || eventCallCount.get() != 0) {
                failWithDecisionDiagnostics(
                    prefix = "服务端返回旧响应后的稳定窗口内出现状态回写",
                    viewModel = viewModel,
                )
            }
            SystemClock.sleep(LATE_RESPONSE_POLL_INTERVAL_MS)
        } while (SystemClock.uptimeMillis() < deadline)
        composeRule.waitForIdle()
        assertLateRecommendationStayedRevoked(viewModel)
    }

    private fun assertNewRecommendationOwnsTheOnlyEvent() {
        assertEquals(1, eventBodies.size)
        val event = Json.parseToJsonElement(eventBodies.single()).jsonObject
        assertEquals(NEW_REQUEST_ID, event.getValue("requestId").jsonPrimitive.content)
        assertEquals(NEW_RESULT_TOKEN, event.getValue("resultToken").jsonPrimitive.content)
        assertEquals("IMPRESSION", event.getValue("type").jsonPrimitive.content)
        assertFalse("旧 token 不得出现在任何事件请求中", eventBodies.single().contains(OLD_RESULT_TOKEN))
    }

    private fun assertBothRecommendationRequestsDisableAi() {
        assertEquals(2, recommendationBodies.size)
        recommendationBodies.forEachIndexed { index, body ->
            val request = Json.parseToJsonElement(body).jsonObject
            assertFalse(
                "第 ${index + 1} 次推荐请求必须显式关闭 AI 辅助",
                request.getValue("aiAssistanceEnabled").jsonPrimitive.boolean,
            )
        }
    }

    private fun failWithDecisionDiagnostics(
        prefix: String,
        viewModel: DecisionViewModel,
    ): Nothing {
        val state = viewModel.uiState.value
        val gate = viewModel.runtimeAppVersionGate.currentState
        fail(
            "$prefix；configCalls=${configCallCount.get()}；" +
                "recommendationCalls=${recommendationCallCount.get()}；" +
                "eventCalls=${eventCallCount.get()}；" +
                "remoteFeatureConfig=${state.remoteFeatureConfig}；" +
                "gateStatus=${gate.status}；" +
                "gateObservedGeneration=${gate.observedConfigurationGeneration}；" +
                "gateTrustedGeneration=${gate.trustedConfigurationGeneration}；" +
                "location=${state.input.location?.label}；" +
                "transientMessage=${state.transientMessage}；" +
                "formError=${state.formError}；loadState=${state.loadState}",
        )
        error("unreachable")
    }

    private fun hasUiText(text: String, substring: Boolean = false): Boolean =
        composeRule.onAllNodesWithText(
            text = text,
            substring = substring,
            useUnmergedTree = true,
        ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    private fun runtimeVersionDispatcher(): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            recordContractBoundary(request)
            return when (request.method to request.requestUrl?.encodedPath) {
                "GET" to "/v1/config" -> when (configCallCount.incrementAndGet()) {
                    1, 4 -> configurationResponse(COMPATIBLE_MINIMUM_VERSION)
                    2 -> configurationResponse(HIGH_MINIMUM_VERSION)
                    3 -> contractResponse(503)
                        .setBody("""{"error":"configuration temporarily unavailable"}""")
                    else -> {
                        unexpectedRequests += "extra config request"
                        configurationResponse(HIGH_MINIMUM_VERSION)
                    }
                }
                "POST" to "/v1/recommendations" -> recommendationResponse(request)
                "POST" to "/v1/recommendation-events" -> {
                    eventCallCount.incrementAndGet()
                    eventBodies += request.body.readUtf8()
                    contractResponse(204)
                }
                else -> {
                    unexpectedRequests += "${request.method} ${request.requestUrl?.encodedPath}"
                    contractResponse(404).setBody("""{"error":"unexpected test request"}""")
                }
            }
        }
    }

    private fun recommendationResponse(request: RecordedRequest): MockResponse {
        recommendationBodies += request.body.readUtf8()
        return when (recommendationCallCount.incrementAndGet()) {
            1 -> {
                firstRecommendationStarted.countDown()
                val released = try {
                    releaseOldRecommendationResponse.await(
                        OLD_RESPONSE_RELEASE_TIMEOUT_MS,
                        TimeUnit.MILLISECONDS,
                    )
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    false
                }
                if (!released) contractViolations += "old recommendation release timed out"
                val response = if (released) {
                    contractResponse(200).setBody(
                        Json.encodeToString(
                            recommendationFixture(
                                requestId = OLD_REQUEST_ID,
                                resultToken = OLD_RESULT_TOKEN,
                                restaurantName = OLD_RESTAURANT_NAME,
                            ),
                        ),
                    )
                } else {
                    contractResponse(504).setBody("""{"error":"test release timeout"}""")
                }
                oldRecommendationResponseReturned.countDown()
                response
            }
            2 -> contractResponse(200).setBody(
                Json.encodeToString(
                    recommendationFixture(
                        requestId = NEW_REQUEST_ID,
                        resultToken = NEW_RESULT_TOKEN,
                        restaurantName = NEW_RESTAURANT_NAME,
                    ),
                ),
            )
            else -> {
                unexpectedRequests += "extra recommendation request"
                contractResponse(409).setBody("""{"error":"unexpected recommendation"}""")
            }
        }
    }

    private fun recordContractBoundary(request: RecordedRequest) {
        if (request.getHeader(API_CONTRACT_VERSION_HEADER) != API_CONTRACT_VERSION) {
            contractViolations +=
                "${request.method} ${request.requestUrl?.encodedPath}: invalid contract header"
        }
        if (request.getHeader("Authorization") != null) {
            contractViolations +=
                "${request.method} ${request.requestUrl?.encodedPath}: unexpected Authorization"
        }
    }

    private fun configurationResponse(minimumSupportedVersion: String): MockResponse =
        contractResponse(200).setBody(
            """
                {
                  "coverageName": "全国服务",
                  "dataRightsMode": "LIVE_DISPLAY_ONLY",
                  "aiEnabled": false,
                  "accountsEnabled": false,
                  "favoritesEnabled": false,
                  "supportFeedbackEnabled": false,
                  "minimumSupportedVersion": "$minimumSupportedVersion",
                  "ruleVersion": "rule-runtime-version-v1",
                  "promptVersion": "prompt-disabled",
                  "modelVersion": "rule-runtime-version-v1",
                  "serviceCapabilities": {
                    "recommendationsEnabled": true,
                    "locationSearchEnabled": true,
                    "placeSearchEnabled": true
                  }
                }
            """.trimIndent(),
        )

    private fun contractResponse(statusCode: Int): MockResponse = MockResponse()
        .setResponseCode(statusCode)
        .setHeader(API_CONTRACT_VERSION_HEADER, API_CONTRACT_VERSION)
        .setHeader("Content-Type", "application/json; charset=utf-8")

    private fun recommendationFixture(
        requestId: String,
        resultToken: String,
        restaurantName: String,
    ): RecommendationResponse = RecommendationResponse(
        requestId = requestId,
        generatedAt = "2026-08-21T00:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-runtime-version-v1",
        promptVersion = "prompt-disabled",
        modelVersion = "rule-runtime-version-v1",
        aiFallbackUsed = false,
        results = listOf(
            RecommendationResult(
                provider = "DEMO",
                resultToken = resultToken,
                dataMode = RecommendationDataMode.DEMO,
                actions = RecommendationActions(
                    navigate = false,
                    call = false,
                    copyAddress = false,
                    share = false,
                ),
                name = restaurantName,
                address = "北京市海淀区设备内演示地址 2 号",
                rank = 1,
                fitScore = null,
                sourceRating = 4.5,
                averageCostYuan = 22.0,
                distanceMeters = 280.0,
                estimatedTravelMinutes = 5.0,
                estimatedMealMinutes = 25.0,
                openStatus = OpenStatus.OPEN,
                tags = listOf("中式快餐"),
                imageUrl = null,
                phone = null,
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
                warnings = listOf("设备内虚构数据，仅用于版本门禁验收"),
                confidence = Confidence.MEDIUM,
                aiAssisted = false,
                sourceAttribution = "虚构演示数据",
            ),
        ),
        notice = null,
    )

    companion object {
        private const val OPT_IN_ARGUMENT = "runtimeVersionRaise"
        private const val DEVICE_LOOPBACK = "127.0.0.1"
        private const val DEVICE_API_PORT = 3001
        private const val STARTUP_TIMEOUT_MS = 10_000L
        private const val CONFIG_TIMEOUT_MS = 20_000L
        private const val RECOMMENDATION_TIMEOUT_MS = 20_000L
        private const val EVENT_TIMEOUT_MS = 10_000L
        private const val REQUEST_CAPTURE_TIMEOUT_MS = 10_000L
        private const val OLD_RESPONSE_RELEASE_TIMEOUT_MS = 30_000L
        private const val LATE_RESPONSE_STABILITY_WINDOW_MS = 1_000L
        private const val LATE_RESPONSE_POLL_INTERVAL_MS = 50L
        private const val PRIVACY_ACCEPT_ACTION = "同意并继续"
        private const val RECHECK_ACTION = "重新检查"
        private const val UPDATE_HEADING = "需要更新后继续"
        private const val MANUAL_LOCATION = "北京大学东门"
        private const val COMPATIBLE_MINIMUM_VERSION = "0.1.1"
        private const val HIGH_MINIMUM_VERSION = "99.0.0"
        private const val REQUIRED_UPDATE_MESSAGE =
            "当前版本过低，请更新到 99.0.0 或更高版本"
        private const val OLD_REQUEST_ID = "5bb9f42f-6055-48d6-9363-676975779af0"
        private const val NEW_REQUEST_ID = "868a4d5f-0ad1-4590-8268-e3fe4fb10073"
        private const val OLD_RESULT_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        private const val NEW_RESULT_TOKEN = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        private const val OLD_RESTAURANT_NAME = "旧在途推荐（不应显示）"
        private const val NEW_RESTAURANT_NAME = "恢复后新推荐（虚构）"

        private val REMOTE_PRODUCT_TEXTS = listOf(
            "帮我选",
            "搜索附近餐厅 / 菜系 / 食物",
            "账号与安全",
            "收藏与账号记录",
            "问题反馈与餐厅纠错",
            "提交反馈",
        )
    }
}
