package com.chishenme.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.chishenme.app.data.remote.API_CONTRACT_VERSION
import com.chishenme.app.data.remote.API_CONTRACT_VERSION_HEADER
import java.io.IOException
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
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
 * Device-local acceptance test for the credential-free support-feedback boundary.
 *
 * The server owns only the test device loopback port. It proves the Android config,
 * navigation and request contracts without a production key, account or provider.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivitySupportFeedbackLocalFixtureTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    private lateinit var server: MockWebServer
    private var serverStarted = false
    private val feedbackEnabled = AtomicBoolean(true)
    private val configCallCount = AtomicInteger(0)
    private val feedbackCallCount = AtomicInteger(0)
    private val requests = CopyOnWriteArrayList<CapturedRequest>()

    @Before
    fun startDeviceServerAndResetState() {
        assumeTrue(
            "此用例只在显式启用支持反馈设备内夹具时运行",
            InstrumentationRegistry.getArguments().getString(OPT_IN_ARGUMENT) == "true",
        )
        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        val preferencesFile = application.preferencesDataStoreFile(PREFERENCES_FILE)
        assertTrue(
            "无法重置支持反馈夹具状态：${preferencesFile.absolutePath}",
            !preferencesFile.exists() || preferencesFile.delete(),
        )

        server = MockWebServer().apply { dispatcher = supportFeedbackDispatcher() }
        try {
            server.start(InetAddress.getByName(DEVICE_LOOPBACK), DEVICE_API_PORT)
            serverStarted = true
        } catch (error: IOException) {
            throw AssertionError(
                "无法在设备 $DEVICE_LOOPBACK:$DEVICE_API_PORT 启动支持反馈夹具；" +
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
    fun guestPlaceCorrection_submitsThenRuntimeDisableHidesAndBlocksEntry() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitText(PRIVACY_ACCEPT_ACTION)
            assertEquals("隐私同意前不得访问配置或反馈接口", 0, server.requestCount)
            composeRule.onNodeWithText(PRIVACY_ACCEPT_ACTION).performClick()

            composeRule.waitUntil(UI_TIMEOUT_MS) {
                configCallCount.get() >= 1 && hasUiText("手动选择")
            }
            composeRule.onNodeWithContentDescription("设置").assertIsDisplayed().performClick()
            awaitText("设置与透明度")
            scrollToContent(hasText("问题反馈与餐厅纠错"))
                .assertIsDisplayed()
            scrollToContent(hasText("提交") and hasClickAction())
                .assertIsDisplayed()
                .assertIsEnabled()
                .performClick()

            awaitText("问题反馈")
            scrollToContent(hasText("餐厅纠错"))
                .assertIsDisplayed()
                .performClick()
            scrollToContent(hasSetTextAction() and hasText("请描述问题"))
                .assertIsDisplayed()
                .performTextInput(PLACE_CORRECTION_MESSAGE)
            // Hide only the IME; pressing system Back could instead exit this
            // screen and clear the draft through its production BackHandler.
            scenario.onActivity { activity ->
                WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                    .hide(WindowInsetsCompat.Type.ime())
            }
            composeRule.waitForIdle()
            scrollToContent(hasText("提交反馈") and hasClickAction())
                .assertIsDisplayed()
                .assertIsEnabled()
                .performClick()

            awaitScrollableText("反馈已受理", substring = true)
            composeRule.waitUntil(UI_TIMEOUT_MS) { feedbackCallCount.get() == 1 }
            assertSubmittedRequest()

            feedbackEnabled.set(false)
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            composeRule.waitUntil(UI_TIMEOUT_MS) {
                configCallCount.get() >= 2 && hasUiText("问题反馈当前未开放")
            }
            composeRule.onNodeWithText("问题反馈当前未开放").assertIsDisplayed()
            composeRule.onAllNodesWithText("提交反馈").assertCountEquals(0)
            assertEquals("能力撤销后不得产生第二次提交", 1, feedbackCallCount.get())

            composeRule.onNodeWithContentDescription("返回并清除反馈草稿")
                .assertIsDisplayed()
                .performClick()
            awaitText("设置与透明度")
            scrollToContent(hasText("问题反馈与餐厅纠错"))
                .assertIsDisplayed()
            scrollToContent(hasText("当前未开放"))
                .assertIsDisplayed()
            composeRule.onAllNodes(hasText("提交") and hasClickAction()).assertCountEquals(0)
        }

        assertTrue(
            "设备夹具收到未声明接口：$requests",
            requests.all {
                (it.method == "GET" && it.path == "/v1/config") ||
                    (it.method == "POST" && it.path == "/v1/support-feedback")
            },
        )
        assertTrue(
            "所有请求必须携带当前 API 契约版本",
            requests.all { it.contractVersion == API_CONTRACT_VERSION },
        )
    }

    private fun assertSubmittedRequest() {
        val submission = requests.single {
            it.method == "POST" && it.path == "/v1/support-feedback"
        }
        assertNull("游客反馈不得携带 Authorization", submission.authorization)
        assertTrue(
            "反馈请求必须使用 JSON Content-Type",
            submission.contentType?.startsWith("application/json") == true,
        )
        val body = Json.parseToJsonElement(submission.body).jsonObject
        assertEquals(
            setOf("submissionId", "category", "message"),
            body.keys,
        )
        val submissionId = body.getValue("submissionId").jsonPrimitive.content
        assertEquals(4, UUID.fromString(submissionId).version())
        assertEquals(
            "PLACE_CORRECTION",
            body.getValue("category").jsonPrimitive.content,
        )
        assertEquals(
            PLACE_CORRECTION_MESSAGE,
            body.getValue("message").jsonPrimitive.content,
        )
        assertNull("反馈请求 URL 不得包含 query", submission.query)
        assertFalse(
            "反馈正文不得进入 URL request target",
            submission.requestTarget.contains(PLACE_CORRECTION_MESSAGE),
        )
    }

    private fun awaitText(text: String, substring: Boolean = false) {
        composeRule.waitUntil(UI_TIMEOUT_MS) { hasUiText(text, substring) }
        composeRule.onNodeWithText(text, substring = substring).assertIsDisplayed()
    }

    private fun scrollToContent(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        // A short viewport or visible IME can leave later LazyColumn items
        // uncomposed. Materialize the item before targeting its child node.
        composeRule.onNode(
            hasScrollToIndexAction() and !hasAnyAncestor(hasScrollToIndexAction()),
        ).performScrollToNode(matcher)
        return composeRule.onNode(matcher).performScrollTo()
    }

    private fun awaitScrollableText(text: String, substring: Boolean = false) {
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            try {
                scrollToContent(hasText(text, substring = substring)).assertIsDisplayed()
                true
            } catch (_: AssertionError) {
                // The asynchronous receipt may not yet be a list item. Retain
                // the original bounded wait and fail if it never becomes visible.
                false
            }
        }
        composeRule.onNodeWithText(text, substring = substring).assertIsDisplayed()
    }

    private fun hasUiText(text: String, substring: Boolean = false): Boolean =
        composeRule.onAllNodesWithText(
            text,
            substring = substring,
            useUnmergedTree = true,
        ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    private fun supportFeedbackDispatcher(): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val requestUrl = request.requestUrl
            val path = requestUrl?.encodedPath.orEmpty()
            val body = request.body.readUtf8()
            requests += CapturedRequest(
                method = request.method.orEmpty(),
                path = path,
                query = requestUrl?.encodedQuery,
                requestTarget = request.path.orEmpty(),
                authorization = request.getHeader("Authorization"),
                contractVersion = request.getHeader(API_CONTRACT_VERSION_HEADER),
                contentType = request.getHeader("Content-Type"),
                body = body,
            )
            return when (request.method to path) {
                "GET" to "/v1/config" -> {
                    configCallCount.incrementAndGet()
                    contractResponse(200).setBody(configurationBody(feedbackEnabled.get()))
                }
                "POST" to "/v1/support-feedback" -> {
                    feedbackCallCount.incrementAndGet()
                    val submissionId = Json.parseToJsonElement(body)
                        .jsonObject
                        .getValue("submissionId")
                        .jsonPrimitive
                        .content
                    contractResponse(202).setBody(
                        """{"feedbackId":"$submissionId","accepted":true,"retentionAfterClosureDays":180}""",
                    )
                }
                else -> contractResponse(404).setBody("""{"error":"unexpected test request"}""")
            }
        }
    }

    private fun configurationBody(enabled: Boolean): String = """
        {
          "coverageName":"全国服务",
          "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "aiEnabled":false,
          "accountsEnabled":false,
          "favoritesEnabled":false,
          "supportFeedbackEnabled":$enabled,
          "minimumSupportedVersion":"0.1.1",
          "ruleVersion":"rule-feedback-fixture-v1",
          "promptVersion":"prompt-disabled",
          "modelVersion":"rule-feedback-fixture-v1",
          "serviceCapabilities":{
            "recommendationsEnabled":true,
            "locationSearchEnabled":true,
            "placeSearchEnabled":true
          },
          "persistenceCapabilities":{
            "favoritesEnabled":false,
            "historyEnabled":false,
            "privateFeedbackEnabled":false,
            "savedResourceIdsEnabled":false
          },
          "authCapabilities":{
            "accountsEnabled":false,
            "registrationEnabled":false,
            "phoneEnabled":false,
            "wechatEnabled":false,
            "emailEnabled":false,
            "qqEnabled":false,
            "dataExportEnabled":false
          }
        }
    """.trimIndent()

    private fun contractResponse(statusCode: Int): MockResponse = MockResponse()
        .setResponseCode(statusCode)
        .setHeader(API_CONTRACT_VERSION_HEADER, API_CONTRACT_VERSION)
        .setHeader("Content-Type", "application/json; charset=utf-8")

    private data class CapturedRequest(
        val method: String,
        val path: String,
        val query: String?,
        val requestTarget: String,
        val authorization: String?,
        val contractVersion: String?,
        val contentType: String?,
        val body: String,
    )

    private companion object {
        const val OPT_IN_ARGUMENT = "supportFeedbackLocalFixture"
        const val DEVICE_LOOPBACK = "127.0.0.1"
        const val DEVICE_API_PORT = 3001
        const val PREFERENCES_FILE = "app_preferences.preferences_pb"
        const val UI_TIMEOUT_MS = 20_000L
        const val PRIVACY_ACCEPT_ACTION = "同意并继续"
        const val PLACE_CORRECTION_MESSAGE =
            "餐厅门牌地址有误，请核对并更新当前展示地址。"
    }
}
