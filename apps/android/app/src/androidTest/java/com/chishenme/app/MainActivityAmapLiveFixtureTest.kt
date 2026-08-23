package com.chishenme.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
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

    @Before
    fun startDeviceServerAndResetState() {
        assumeTrue(
            "此用例只在显式启用高德设备内展示夹具时运行",
            InstrumentationRegistry.getArguments().getString(OPT_IN_ARGUMENT) == "true",
        )
        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        val preferencesFile = application.preferencesDataStoreFile(PREFERENCES_FILE)
        assertTrue(
            "无法重置高德展示夹具状态：${preferencesFile.absolutePath}",
            !preferencesFile.exists() || preferencesFile.delete(),
        )

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
            awaitText("同意并继续")
            assertEquals("隐私同意前不得访问配置或地点服务", 0, server.requestCount)
            composeRule.onNodeWithText("同意并继续").performClick()
            awaitText("手动选择")
            composeRule.onNodeWithText("手动选择").performClick()
            composeRule.onNodeWithText("快捷地点（始终可用）").performScrollTo()
            composeRule.onNodeWithText(MANUAL_LOCATION)
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
            composeRule.onNode(hasClickAction() and hasText("帮我决定"))
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            awaitText(RESTAURANT_NAME)
            scrollResultsTo(RESTAURANT_NAME)
            composeRule.onNodeWithText(RESTAURANT_NAME).assertIsDisplayed()
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

    private fun assertTransportContract() {
        requests.forEach { request ->
            assertEquals(API_CONTRACT_VERSION, request.contractVersion)
            assertNull("高德访客展示不得携带账号凭据", request.authorization)
        }
        val recommendation = requests.single { it.path == "/v1/recommendations" }
        val requestBody = Json.parseToJsonElement(recommendation.body).jsonObject
        assertEquals("WGS84", requestBody.getValue("location").jsonObject
            .getValue("crs").jsonPrimitive.content)
        assertEquals(25, requestBody.getValue("budgetMaxYuan").jsonPrimitive.content.toInt())
        assertEquals(1_500, requestBody.getValue("radiusMeters").jsonPrimitive.content.toInt())
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
          "coverageName":"北京四环试点区",
          "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "aiEnabled":false,
          "accountsEnabled":false,
          "favoritesEnabled":false,
          "supportFeedbackEnabled":false,
          "minimumSupportedVersion":"0.1.0",
          "ruleVersion":"rule-amap-device-fixture-v1",
          "promptVersion":"prompt-disabled",
          "modelVersion":"rule-amap-device-fixture-v1"
        }
    """.trimIndent()

    private fun recommendationBody(): String = """
        {
          "requestId":"50000000-0000-4000-8000-000000000001",
          "generatedAt":"2026-08-22T00:00:00Z",
          "coverage":"BEIJING_FOURTH_RING",
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
    }
}
