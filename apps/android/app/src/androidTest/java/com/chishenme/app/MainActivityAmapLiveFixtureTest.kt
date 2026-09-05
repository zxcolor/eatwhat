package com.chishenme.app

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
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.chishenme.app.data.remote.API_CONTRACT_VERSION
import com.chishenme.app.data.remote.API_CONTRACT_VERSION_HEADER
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
    fun liveAmapResponse_isAttributedUnscoredAndCannotLaunchOutboundActions() {
        ActivityScenario.launch(MainActivity::class.java).use {
            enterManualLocation()
            scrollHomeTo(hasClickAction() and hasText("帮我决定"))
                .assertIsDisplayed()
                .performClick()

            awaitText(RESTAURANT_NAME)
            composeRule.onNodeWithText("本次用餐候选").assertIsDisplayed()
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
                .assertIsDisplayed()
            composeRule.onNodeWithText("综合路程", substring = true).assertDoesNotExist()
            composeRule.onNodeWithText("知道了").assertIsDisplayed().performClick()

            composeRule.onNode(hasClickAction() and hasText(RESTAURANT_NAME, substring = true))
                .assertIsDisplayed()
                .performClick()
            awaitText("餐厅详情")
            composeRule.onNodeWithText("数据来源：高德地图实时数据")
                .performScrollTo()
                .assertIsDisplayed()
            for (action in listOf("地图查询", "复制地址", "联系商户")) {
                composeRule.onNodeWithText(action)
                    .performScrollTo()
                    .assertIsDisplayed()
                    .assertIsNotEnabled()
            }
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
        ActivityScenario.launch(MainActivity::class.java).use {
            enterManualLocation()
            scrollHomeTo(hasText("精细匹配") and hasClickAction()).performClick()
            radiusOption("750 m").assertIsSelected()
            radiusOption("1.25 km").assertIsDisplayed()
            captureSyntheticScreenshot("single-radius-750-default.png")

            // The initial configuration notice can cover the bottom of the
            // scrolled scenario row. Wait for its real dismissal before tapping.
            composeRule.waitUntil(UI_TIMEOUT_MS) {
                !hasUiText("已按当前服务建议将最远距离调整为 750 米。")
            }
            // Fixed options respect the live upper bound. A user's scenario is
            // still preserved and must be corrected explicitly when it exceeds it.
            scrollHomeTo(hasText("工作日午餐") and hasClickAction()).performClick()
            composeRule.onNode(hasText("工作日午餐") and hasClickAction()).assertIsSelected()
            val error = "当前服务最远支持 1250 米，你选择了 1500 米。请调整最远距离后重试。"
            scrollHomeTo(hasText("帮我决定") and hasClickAction()).performClick()
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
            scrollHomeTo(hasText("精细匹配") and hasClickAction()).performClick()
            radiusOption("1.5 km").assertIsSelected()
            scrollHomeTo(hasText("将最远距离改为 750 米") and hasClickAction()).performClick()
            radiusOption("750 m").assertIsSelected()
            captureSyntheticScreenshot("single-radius-explicit-correction.png")
            scrollHomeTo(hasText("帮我决定") and hasClickAction()).performClick()

            awaitText(RESTAURANT_NAME)
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

    private fun enterManualLocation() {
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            hasUiText("同意并继续") || hasUiText("手动选择")
        }
        if (hasUiText("同意并继续")) {
            assertEquals("隐私同意前不得访问配置或地点服务", 0, server.requestCount)
            composeRule.onNodeWithText("同意并继续").performClick()
        }
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            requests.any { it.path == "/v1/config" } && hasUiText("手动选择")
        }
        composeRule.onNodeWithText("手动选择").performClick()
        composeRule.onNodeWithText("快捷地点（始终可用）").performScrollTo()
        composeRule.onNodeWithText(MANUAL_LOCATION)
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
    }

    private fun scrollHomeTo(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        composeRule.onNode(
            hasScrollToIndexAction() and !hasAnyAncestor(hasScrollToIndexAction()),
        ).performScrollToNode(matcher)
        return composeRule.onNode(matcher).performScrollTo().assertIsDisplayed()
    }

    private fun radiusOption(text: String): SemanticsNodeInteraction {
        scrollHomeTo(hasText("最远距离"))
        val radiusLabels = listOf("500 m", "750 m", "1 km", "1.25 km", "1.5 km", "3 km", "5 km")
            .map { hasText(it) }.reduce { result, next -> result or next }
        composeRule.onNode(
            hasScrollToIndexAction() and hasAnyAncestor(hasScrollToIndexAction()) and
                hasAnyDescendant(radiusLabels),
        ).performScrollToNode(hasText(text))
        return composeRule.onNode(hasClickAction() and hasText(text))
            .performScrollTo()
            .assertIsDisplayed()
    }

    private fun captureSyntheticScreenshot(fileName: String) {
        composeRule.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            val activeWindow = instrumentation.uiAutomation.rootInActiveWindow
                ?: return@waitUntil false
            assertEquals(
                "A system dialog or another app must not obscure the fixture screenshot",
                instrumentation.targetContext.packageName,
                activeWindow.packageName?.toString(),
            )
            true
        }
        assertEquals(
            "The fixture must remain the active window immediately before capture",
            instrumentation.targetContext.packageName,
            checkNotNull(instrumentation.uiAutomation.rootInActiveWindow).packageName?.toString(),
        )
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try {
            java.io.File(instrumentation.targetContext.cacheDir, fileName)
                .outputStream().use { output ->
                    assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output))
                }
        } finally {
            bitmap.recycle()
        }
    }

    private fun scrollResultsTo(text: String, substring: Boolean = false) {
        composeRule.onNode(hasScrollToIndexAction())
            .performScrollToNode(hasText(text, substring = substring))
    }

    private fun awaitText(text: String) {
        composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) { hasUiText(text) }
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
          "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "aiEnabled":false,
          "accountsEnabled":false,
          "favoritesEnabled":false,
          "supportFeedbackEnabled":false,
          "minimumSupportedVersion":"0.1.1",
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
