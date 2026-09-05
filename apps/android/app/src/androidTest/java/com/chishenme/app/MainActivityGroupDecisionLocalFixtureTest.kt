package com.chishenme.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
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
import androidx.lifecycle.Lifecycle
import com.chishenme.app.data.remote.API_CONTRACT_VERSION
import com.chishenme.app.data.remote.API_CONTRACT_VERSION_HEADER
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
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
 * Device-local acceptance fixture for the display-only, same-device anonymous group flow.
 * It needs no account, provider key, room service or production endpoint.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityGroupDecisionLocalFixtureTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    private lateinit var server: MockWebServer
    private var serverStarted = false
    private val configCallCount = AtomicInteger(0)
    private val groupCallCount = AtomicInteger(0)
    private val requests = CopyOnWriteArrayList<CapturedRequest>()
    @Volatile
    private var configuredRadiusMeters: Int? = null

    @Before
    fun startDeviceServerAndResetState() {
        assumeTrue(
            "此用例只在显式启用群组决策设备内夹具时运行",
            InstrumentationRegistry.getArguments().getString(OPT_IN_ARGUMENT) == "true",
        )
        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        if (preferencesReset.compareAndSet(false, true)) {
            val preferencesFile = application.preferencesDataStoreFile(PREFERENCES_FILE)
            assertTrue(
                "无法重置群组决策夹具状态：${preferencesFile.absolutePath}",
                !preferencesFile.exists() || preferencesFile.delete(),
            )
        }

        server = MockWebServer().apply { dispatcher = groupDispatcher() }
        try {
            server.start(InetAddress.getByName(DEVICE_LOOPBACK), DEVICE_API_PORT)
            serverStarted = true
        } catch (error: IOException) {
            throw AssertionError(
                "无法在设备 $DEVICE_LOOPBACK:$DEVICE_API_PORT 启动群组决策夹具；" +
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
    fun twoAnonymousMembers_submitStrictRequestAndReceiveReadOnlyLiveCandidates() {
        ActivityScenario.launch(MainActivity::class.java).use {
            enterGroupFlow()
            composeRule.onAllNodes(hasSetTextAction()).assertCountEquals(0)

            clickScrollableAction("确认第 1 位条件")
            awaitText("第 2 位 / 共 2 位")
            clickScrollableAction("确认第 2 位条件")
            clickScrollableAction("复核共同条件")
            awaitText("共同条件复核")
            clickScrollableAction("按共同条件查找候选")

            awaitText(RESTAURANT_NAME)
            scrollToContent(hasText("首个候选")).assertIsDisplayed()
            scrollToContent(hasText("保持数据源返回顺序", substring = true))
                .assertIsDisplayed()
            scrollToContent(hasText("不计算平台匹配分", substring = true))
                .assertIsDisplayed()
            captureSyntheticScreenshot("group-live-rights.png")
            assertFalse(
                "实时群组展示不得显示透明规则匹配分",
                hasUiText("透明规则匹配分", substring = true),
            )

            scrollToContent(hasTestTag("group-result-card-0"))
                .assertIsDisplayed()
                .assertHasNoClickAction()
            composeRule.onAllNodes(
                hasClickAction() and hasAnyAncestor(hasTestTag("group-result-card-0")),
                useUnmergedTree = true,
            ).assertCountEquals(0)
            captureSyntheticScreenshot("group-readonly-result.png")
            scrollToContent(hasTestTag("group-action-edit"))
                .assertIsDisplayed()
            composeRule.onNodeWithTag("group-action-retry").assertIsDisplayed()
            composeRule.onAllNodes(hasClickAction()).assertCountEquals(3)

            for (forbiddenAction in listOf("餐厅详情", "地图查询", "联系商户", "复制地址", "收藏", "提交反馈", "分享")) {
                composeRule.onAllNodes(
                    hasClickAction() and hasText(forbiddenAction, substring = true),
                ).assertCountEquals(0)
            }
            composeRule.waitUntil(UI_TIMEOUT_MS) { groupCallCount.get() == 1 }
        }

        assertTransportContract()
    }

    @Test
    fun publicRadiusDefaults_keepExactReviewAndRequireExplicitIntersectionCorrection() {
        configuredRadiusMeters = 1_250
        ActivityScenario.launch(MainActivity::class.java).use {
            enterGroupFlow()
            scrollToContent(hasText("当前服务最远支持 1250 米", substring = true))
                .assertIsDisplayed()
            radiusOption("1.25 公里").assertIsSelected()
            captureSyntheticScreenshot("group-radius-1250-default.png")
            clickScrollableAction("确认第 1 位条件")
            awaitText("第 2 位 / 共 2 位")
            radiusOption("1.25 公里").assertIsSelected()
            clickScrollableAction("确认第 2 位条件")
            clickScrollableAction("复核共同条件")
            scrollToContent(hasText("1250 米")).assertIsDisplayed()
            assertFalse("共同约束不得将1250米舍入为1.3公里", hasUiText("1.3 公里"))
            captureSyntheticScreenshot("group-radius-1250-review.png")

            clickScrollableAction("返回重新录入")
            clickScrollableAction("第 1 位")
            radiusOption("1.5 公里").performClick()
            clickScrollableAction("确认第 1 位条件")
            radiusOption("1.5 公里").performClick()
            clickScrollableAction("确认第 2 位条件")
            clickScrollableAction("复核共同条件")
            val error = "共同最远距离为 1500 米，当前服务最远支持 1250 米。" +
                "请由成员主动调整距离，再复核共同条件。"
            scrollToContent(hasText(error)).assertIsDisplayed()
            assertEquals("共同距离超限不得发送请求", 0, groupCallCount.get())
            captureSyntheticScreenshot("group-radius-over-limit.png")

            clickScrollableAction("第 1 位")
            radiusOption("1.5 公里").assertIsSelected()
            radiusOption("1.25 公里").performClick()
            clickScrollableAction("确认第 1 位条件")
            radiusOption("1.5 公里").assertIsSelected()
            clickScrollableAction("复核共同条件")
            scrollToContent(hasText("1250 米")).assertIsDisplayed()
            clickScrollableAction("按共同条件查找候选")
            awaitText(RESTAURANT_NAME)
            scrollToContent(hasTestTag("group-result-card-0"))
                .assertIsDisplayed()
                .assertHasNoClickAction()
            captureSyntheticScreenshot("group-radius-corrected-result.png")
            composeRule.waitUntil(UI_TIMEOUT_MS) { groupCallCount.get() == 1 }
        }
        assertTransportContract(expectedMemberRadii = listOf(1_250, 1_500))
    }

    @Test
    fun configurationRecreation_keepsInMemoryProgressWithoutRouteArguments() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            enterGroupFlow()
            clickScrollableAction("确认第 1 位条件")
            awaitText("第 2 位 / 共 2 位")

            scenario.recreate()

            awaitText("第 2 位 / 共 2 位")
            composeRule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
            clickScrollableAction("确认第 2 位条件")
            clickScrollableAction("复核共同条件")
            clickScrollableAction("按共同条件查找候选")
            awaitText(RESTAURANT_NAME)
            composeRule.waitUntil(UI_TIMEOUT_MS) { groupCallCount.get() == 1 }
        }

        assertTransportContract()
    }

    @Test
    fun realBackgroundTransition_clearsGroupProgressAndDoesNotSubmit() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            enterGroupFlow()
            clickScrollableAction("确认第 1 位条件")
            awaitText("第 2 位 / 共 2 位")

            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)

            composeRule.waitUntil(UI_TIMEOUT_MS) {
                configCallCount.get() >= 2 && hasUiText("现在这一顿，30 秒决定")
            }
            assertFalse("后台清理后不得停留在已关闭群组页", hasUiText("当前不可用"))
            assertFalse("真实后台返回后不得恢复成员进度", hasUiText("第 2 位 / 共 2 位"))
            assertEquals("后台清理不得提交群组请求", 0, groupCallCount.get())
        }
    }

    private fun enterGroupFlow() {
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            hasUiText("同意并继续") || hasUiText("手动选择")
        }
        if (hasUiText("同意并继续")) {
            assertEquals("隐私同意前不得访问配置或群组接口", 0, server.requestCount)
            composeRule.onNodeWithText("同意并继续").performClick()
        }

        composeRule.waitUntil(UI_TIMEOUT_MS) {
            configCallCount.get() >= 1 && hasUiText("手动选择")
        }
        composeRule.onNodeWithText("手动选择").performClick()
        composeRule.onNodeWithText("快捷地点（始终可用）").performScrollTo()
        composeRule.onNodeWithText(MANUAL_LOCATION)
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()

        composeRule.onNode(hasClickAction() and hasText("开始同机填写"))
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        awaitText("第 1 位 / 共 2 位")
    }

    private fun assertTransportContract(expectedMemberRadii: List<Int> = listOf(1_500, 1_500)) {
        assertTrue(
            "设备夹具收到未声明接口：$requests",
            requests.all {
                (it.method == "GET" && it.path == "/v1/config") ||
                    (it.method == "POST" && it.path == "/v1/group-recommendations")
            },
        )
        assertTrue(
            "所有请求必须携带当前 API 契约版本",
            requests.all { it.contractVersion == API_CONTRACT_VERSION },
        )
        val submission = requests.single {
            it.method == "POST" && it.path == "/v1/group-recommendations"
        }
        assertNull("匿名群组请求不得携带 Authorization", submission.authorization)
        assertNull("群组请求 URL 不得包含 query", submission.query)
        assertTrue(
            "群组请求必须使用 JSON Content-Type",
            submission.contentType?.startsWith("application/json") == true,
        )

        val body = Json.parseToJsonElement(submission.body).jsonObject
        assertEquals(setOf("location", "travelMode", "members"), body.keys)
        assertEquals("WALK", body.getValue("travelMode").jsonPrimitive.content)
        assertEquals(
            setOf("latitude", "longitude", "accuracyMeters", "crs"),
            body.getValue("location").jsonObject.keys,
        )
        val members = body.getValue("members").jsonArray
        assertEquals(2, members.size)
        members.forEachIndexed { index, memberElement ->
            val member = memberElement.jsonObject
            assertEquals(
                setOf(
                    "budgetMaxYuan",
                    "availableMinutes",
                    "radiusMeters",
                    "preferredCuisines",
                    "excludedCuisines",
                ),
                member.keys,
            )
            assertTrue(member.getValue("budgetMaxYuan").toString() == "null")
            assertEquals("60", member.getValue("availableMinutes").jsonPrimitive.content)
            assertEquals(
                expectedMemberRadii[index].toString(),
                member.getValue("radiusMeters").jsonPrimitive.content,
            )
            assertTrue(member.getValue("preferredCuisines").jsonArray.isEmpty())
            assertTrue(member.getValue("excludedCuisines").jsonArray.isEmpty())
        }
        for (forbiddenKey in listOf(
            "name",
            "memberId",
            "groupId",
            "locationLabel",
            "requestTime",
            "aiAssistanceEnabled",
            "weatherContext",
            "accountId",
        )) {
            assertFalse("群组请求不得出现 $forbiddenKey", submission.body.contains("\"$forbiddenKey\""))
        }
    }

    private fun clickScrollableAction(text: String) {
        scrollToContent(hasClickAction() and hasText(text))
            .assertIsDisplayed()
            .performClick()
    }

    private fun radiusOption(text: String): SemanticsNodeInteraction {
        scrollToContent(hasText("最远距离")).assertIsDisplayed()
        val radiusLabels = listOf("500 米", "1 公里", "1.25 公里", "1.5 公里", "3 公里", "5 公里")
            .map { hasText(it) }.reduce { result, next -> result or next }
        composeRule.onNode(
            hasScrollToIndexAction() and hasAnyAncestor(hasScrollToIndexAction()) and
                hasAnyDescendant(radiusLabels),
        ).performScrollToNode(hasText(text))
        return composeRule.onNode(hasClickAction() and hasText(text))
            .performScrollTo()
            .assertIsDisplayed()
    }

    private fun scrollToContent(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        // LazyColumn items may not have semantics until scrolled into composition.
        // Exclude nested cuisine/option LazyRows when finding the outer list.
        composeRule.onNode(
            hasScrollToIndexAction() and !hasAnyAncestor(hasScrollToIndexAction()),
        ).performScrollToNode(matcher)
        return composeRule.onNode(matcher).performScrollTo()
    }

    private fun captureSyntheticScreenshot(fileName: String) {
        // This opt-in fixture serves synthetic data only. Screenshots remain in
        // the test device cache and are never part of normal app persistence.
        composeRule.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        try {
            composeRule.waitUntil(UI_TIMEOUT_MS) {
                val activeWindow = instrumentation.uiAutomation.rootInActiveWindow
                    ?: return@waitUntil false
                // Only an absent accessibility root is transient. Never wait for
                // an obscuring system dialog or another app to disappear.
                assertEquals(
                    "A system dialog or another app must not obscure the fixture screenshot",
                    instrumentation.targetContext.packageName,
                    activeWindow.packageName?.toString(),
                )
                true
            }
        } catch (error: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError(
                "Accessibility root remained unavailable for $UI_TIMEOUT_MS ms before fixture screenshot",
                error,
            )
        }
        val activeWindow = checkNotNull(instrumentation.uiAutomation.rootInActiveWindow) {
            "Accessibility root became unavailable immediately before fixture screenshot"
        }
        assertEquals(
            "A system dialog or another app must not obscure the fixture screenshot",
            instrumentation.targetContext.packageName,
            activeWindow.packageName?.toString(),
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

    private fun awaitText(text: String) {
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            if (!hasUiText(text)) {
                try {
                    scrollToContent(hasText(text))
                } catch (_: AssertionError) {
                    // A phase's item is absent until the asynchronous state arrives.
                    // The bounded wait still fails if it never becomes available.
                }
            }
            hasUiText(text)
        }
    }

    private fun hasUiText(text: String, substring: Boolean = false): Boolean =
        composeRule.onAllNodesWithText(
            text,
            substring = substring,
            useUnmergedTree = true,
        ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    private fun groupDispatcher(): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val requestUrl = request.requestUrl
            val path = requestUrl?.encodedPath.orEmpty()
            val body = request.body.readUtf8()
            requests += CapturedRequest(
                method = request.method.orEmpty(),
                path = path,
                query = requestUrl?.encodedQuery,
                authorization = request.getHeader("Authorization"),
                contractVersion = request.getHeader(API_CONTRACT_VERSION_HEADER),
                contentType = request.getHeader("Content-Type"),
                body = body,
            )
            return when (request.method to path) {
                "GET" to "/v1/config" -> {
                    configCallCount.incrementAndGet()
                    contractResponse(200).setBody(configurationBody())
                }
                "POST" to "/v1/group-recommendations" -> {
                    groupCallCount.incrementAndGet()
                    contractResponse(200).setBody(groupResponseBody())
                }
                else -> contractResponse(404).setBody("""{"error":"unexpected test request"}""")
            }
        }
    }

    private fun configurationBody(): String = """
        {
          "coverageName":"全国服务",
          ${configuredRadiusMeters?.let { """
          "recommendationDefaults":{
            "areaCode":"NATIONWIDE","defaultRadiusMeters":$it,"maximumRadiusMeters":$it
          },
          """.trimIndent() }.orEmpty()}
          "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "aiEnabled":false,
          "accountsEnabled":false,
          "favoritesEnabled":false,
          "supportFeedbackEnabled":false,
          "minimumSupportedVersion":"0.1.1",
          "ruleVersion":"group-fixture-rule-v1",
          "promptVersion":"prompt-disabled",
          "modelVersion":"group-fixture-rule-v1",
          "serviceCapabilities":{
            "recommendationsEnabled":true,
            "locationSearchEnabled":true,
            "placeSearchEnabled":true,
            "groupRecommendationsEnabled":true
          }
        }
    """.trimIndent()

    private fun groupResponseBody(): String = """
        {
          "requestId":"70000000-0000-4000-8000-000000000001",
          "generatedAt":"2026-09-03T00:00:00Z",
          "coverage":"NATIONWIDE",
          "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "ruleVersion":"group-fixture-rule-v1",
          "aggregation":{
            "version":"group-constraints-v1",
            "memberCount":2,
            "effectiveBudgetMaxYuan":null,
            "effectiveAvailableMinutes":60,
            "effectiveRadiusMeters":${configuredRadiusMeters ?: 1_500},
            "preferredCuisines":[],
            "excludedCuisines":[]
          },
          "results":[{
            "provider":"AMAP",
            "dataMode":"LIVE",
            "name":"$RESTAURANT_NAME",
            "address":"北京市海淀区设备内群组测试路 2 号",
            "rank":1,
            "fitScore":null,
            "sourceRating":4.4,
            "averageCostYuan":28.0,
            "distanceMeters":620.0,
            "estimatedTravelMinutes":9.0,
            "estimatedMealMinutes":35.0,
            "openStatus":"OPEN",
            "tags":["面食"],
            "reasons":[{"code":"DISTANCE_FIT","text":"在共同最远距离内"}],
            "warnings":[],
            "confidence":"HIGH",
            "sourceAttribution":"高德地图实时数据"
          }],
          "notice":null
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
        val authorization: String?,
        val contractVersion: String?,
        val contentType: String?,
        val body: String,
    )

    private companion object {
        const val OPT_IN_ARGUMENT = "groupDecisionLocalFixture"
        const val DEVICE_LOOPBACK = "127.0.0.1"
        const val DEVICE_API_PORT = 3001
        const val PREFERENCES_FILE = "app_preferences.preferences_pb"
        const val UI_TIMEOUT_MS = 20_000L
        const val MANUAL_LOCATION = "北京电子科技学院"
        const val RESTAURANT_NAME = "两人共同候选面馆"
        val preferencesReset = AtomicBoolean(false)
    }
}
