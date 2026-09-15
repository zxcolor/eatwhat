package com.chishenme.app

import android.graphics.Rect
import android.os.Build
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
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
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
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
import java.time.Instant
import java.time.temporal.ChronoUnit
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
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-local acceptance test for the credential-free account integration boundary.
 *
 * The fixture is deliberately not a fake SMS, mail, WeChat or QQ provider. It owns only
 * the App's localhost API port and proves the Android transport/UI contract with synthetic
 * v1 responses. Native OAuth stays fail-closed because this test APK has no platform AppID.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityAuthLocalFixtureTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    private lateinit var server: MockWebServer
    private var serverStarted = false
    private val requests = CopyOnWriteArrayList<CapturedRequest>()
    private val emailBound = AtomicBoolean(false)
    private val loginCount = AtomicInteger(0)

    @Before
    fun startDeviceServerAndResetState() {
        assumeTrue(
            "此用例只在显式启用账号设备内夹具时运行",
            InstrumentationRegistry.getArguments().getString(OPT_IN_ARGUMENT) == "true",
        )
        assertTrue(
            "账号关闭态夹具要求默认测试包不携带微信 AppID",
            readMainBuildConfigString("CHISHENME_WECHAT_APP_ID").isBlank(),
        )
        assertTrue(
            "账号关闭态夹具要求默认测试包不携带 QQ AppID",
            readMainBuildConfigString("CHISHENME_QQ_APP_ID").isBlank(),
        )
        listOf(ACCESS_TOKEN_ONE, REFRESH_TOKEN_ONE, ACCESS_TOKEN_TWO, REFRESH_TOKEN_TWO)
            .forEach { token ->
                assertTrue(
                    "账号夹具令牌必须是 43 位安全不透明值",
                    token.matches(Regex("^[A-Za-z0-9_-]{43}$")),
                )
            }

        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        val preferencesFile = application.preferencesDataStoreFile(PREFERENCES_FILE)
        assertTrue(
            "无法重置账号夹具状态：${preferencesFile.absolutePath}",
            !preferencesFile.exists() || preferencesFile.delete(),
        )

        server = MockWebServer().apply { dispatcher = authDispatcher() }
        try {
            server.start(InetAddress.getByName(DEVICE_LOOPBACK), DEVICE_API_PORT)
            serverStarted = true
        } catch (error: IOException) {
            throw AssertionError(
                "无法在设备 $DEVICE_LOOPBACK:$DEVICE_API_PORT 启动账号夹具；" +
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

    private fun readMainBuildConfigString(fieldName: String): String =
        Class.forName("com.chishenme.app.BuildConfig")
            .getField(fieldName)
            .get(null) as String

    @Test
    fun phoneLogin_emailBind_emailLogin_andNativeOAuthRemainFailClosed() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            acceptPrivacyAndOpenAccount()
            captureAccountOverview("account-guest-overview.png")

            assertGuestChannelPresentation()
            requestOtpAndSubmit(
                scenario = scenario,
                inputLabel = "手机号",
                target = PHONE_NUMBER,
                sendAction = "发送验证码",
                maskedTarget = PHONE_MASK,
                submitAction = "验证并登录 / 创建账号",
                keyboardScreenshot = "account-phone-keyboard.png",
            )
            awaitText("已安全登录")
            awaitRequestCount(5)
            awaitSecurityDataReady()
            assertCredentialsNotExposedAcrossSignedInAccount(
                itemCount = SIGNED_IN_WITH_EMAIL_BIND_ITEM_COUNT,
            )
            captureAccountOverview("account-signed-in-overview.png")

            bindEmail(scenario)
            awaitRequestCount(9)
            scrollAccountTo("邮箱 · $EMAIL_MASK")
            composeRule.onNodeWithText("邮箱 · $EMAIL_MASK").assertIsDisplayed()

            logoutAndAwaitGuest()
            selectEmailLogin()
            requestOtpAndSubmit(
                scenario = scenario,
                inputLabel = "邮箱",
                target = EMAIL,
                sendAction = "发送验证码",
                maskedTarget = EMAIL_MASK,
                submitAction = "安全登录",
                keyboardScreenshot = "account-email-keyboard.png",
            )
            awaitText("已安全登录")
            awaitRequestCount(14)
            awaitSecurityDataReady()
            scrollAccountTo("邮箱 · $EMAIL_MASK")
            composeRule.onNodeWithText("邮箱 · $EMAIL_MASK").assertIsDisplayed()
            assertCredentialsNotExposedAcrossSignedInAccount(
                itemCount = SIGNED_IN_EMAIL_BOUND_ITEM_COUNT,
            )
            captureAccountOverview("account-email-bound-overview.png")
            logoutAndAwaitGuest()
        }

        assertTransportContract()
    }

    private fun acceptPrivacyAndOpenAccount() {
        awaitText("同意并继续")
        assertEquals("隐私同意前不得访问账号或配置接口", 0, server.requestCount)
        composeRule.onNodeWithText("同意并继续")
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        awaitText("现在决定")
        awaitRequestCount(1)
        composeRule.homeSettingsAction().assertIsDisplayed().performClick()
        awaitText("设置与透明度")
        composeRule.onNodeWithText("账号与安全")
            .performScrollTo()
            .assertIsDisplayed()
        // The card title is descriptive text; the explicit action at the end
        // of the first settings card is the account-management entry point.
        composeRule.onAllNodesWithText("管理")[0]
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        awaitText("不登录也能决定吃什么")
    }

    private fun assertGuestChannelPresentation() {
        scrollAccountTo("手机号 / 邮箱验证码")
        composeRule.onNodeWithText("手机号 / 邮箱验证码").assertIsDisplayed()

        scrollAccountTo("此安装包未配置微信开放平台 AppID，微信能力已安全关闭。")
        composeRule.onNodeWithText("此安装包未配置微信开放平台 AppID，微信能力已安全关闭。")
            .assertIsDisplayed()

        scrollAccountTo("此安装包未配置腾讯 QQ 互联 AppID，QQ 能力已安全关闭。")
        composeRule.onNodeWithText("此安装包未配置腾讯 QQ 互联 AppID，QQ 能力已安全关闭。")
            .assertIsDisplayed()
        assertTextsAbsentAcrossAccountItems(
            itemCount = GUEST_ACCOUNT_ITEM_COUNT,
            forbiddenTexts = listOf(
                "使用微信安全登录",
                "发送注册验证码",
                "微信授权并创建账号",
                "使用 QQ 安全登录",
            ),
            failureMessage = { text, index ->
                "未配置 AppID 时不得出现 OAuth 动作：$text（账号列表索引 $index）"
            },
        )
    }

    private fun assertCredentialsNotExposedAcrossSignedInAccount(itemCount: Int) {
        assertTextsAbsentAcrossAccountItems(
            itemCount = itemCount,
            forbiddenTexts = listOf(
                ACCESS_TOKEN_ONE,
                REFRESH_TOKEN_ONE,
                ACCESS_TOKEN_TWO,
                REFRESH_TOKEN_TWO,
            ),
            failureMessage = { _, index ->
                "任何访问或刷新令牌都不得显示在账号界面（账号列表索引 $index）"
            },
        )
    }

    private fun assertTextsAbsentAcrossAccountItems(
        itemCount: Int,
        forbiddenTexts: List<String>,
        failureMessage: (text: String, index: Int) -> String,
    ) {
        repeat(itemCount) { index ->
            composeRule.onNode(hasScrollToIndexAction()).performScrollToIndex(index)
            forbiddenTexts.forEach { text ->
                assertFalse(failureMessage(text, index), hasUiText(text))
            }
        }
    }

    private fun requestOtpAndSubmit(
        scenario: ActivityScenario<MainActivity>,
        inputLabel: String,
        target: String,
        sendAction: String,
        maskedTarget: String,
        submitAction: String,
        keyboardScreenshot: String,
    ) {
        scrollAccountTo(sendAction)
        captureEmptyInputWithKeyboard(scenario, inputLabel, keyboardScreenshot)
        composeRule.onNode(hasSetTextAction() and hasText(inputLabel))
            .performScrollTo()
            .assertIsDisplayed()
            .performTextInput(target)
        awaitInputKeyboardIdle(scenario)
        composeRule.onNode(hasClickAction() and hasText(sendAction))
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        awaitText("验证码已发送至 $maskedTarget")
        composeRule.onNode(hasSetTextAction() and hasText("6 位验证码"))
            .performScrollTo()
            .assertIsDisplayed()
            .performTextInput(OTP)
        awaitInputKeyboardIdle(scenario)
        composeRule.onNode(hasClickAction() and hasText(submitAction))
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
    }

    private fun bindEmail(scenario: ActivityScenario<MainActivity>) {
        scrollAccountTo("绑定邮箱")
        // Opening the IME changes the viewport asynchronously. Verify the empty field above
        // the real keyboard and capture stable frames before typing, as in both login flows.
        captureEmptyInputWithKeyboard(scenario, "邮箱", "account-email-bind-keyboard.png")
        composeRule.onNode(hasSetTextAction() and hasText("邮箱"))
            .performScrollTo()
            .assertIsDisplayed()
            .performTextInput(EMAIL)
        awaitInputKeyboardIdle(scenario)
        composeRule.onNode(hasClickAction() and hasText("发送绑定验证码"))
            .performScrollTo()
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()
        awaitText("验证码已发送至 $EMAIL_MASK")
        composeRule.onNode(hasSetTextAction() and hasText("6 位验证码"))
            .performScrollTo()
            .assertIsDisplayed()
            .performTextInput(OTP)
        awaitInputKeyboardIdle(scenario)
        composeRule.onNode(hasClickAction() and hasText("确认绑定"))
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        awaitRequestCount(9)
        awaitSecurityDataReady()
        scrollAccountTo("邮箱 · $EMAIL_MASK")
        composeRule.onNodeWithText("邮箱 · $EMAIL_MASK").assertIsDisplayed()
    }

    private fun logoutAndAwaitGuest() {
        scrollAccountTo("退出当前账号")
        composeRule.onNode(hasClickAction() and hasText("退出当前账号"))
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()
        awaitText("不登录也能决定吃什么")
        scrollAccountTo("手机号 / 邮箱验证码")
        composeRule.onNodeWithText("手机号 / 邮箱验证码").assertIsDisplayed()
    }

    private fun selectEmailLogin() {
        scrollAccountTo("手机号 / 邮箱验证码")
        composeRule.onNode(hasClickAction() and hasText("邮箱"))
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
    }

    private fun scrollAccountTo(text: String) {
        val node = composeRule.onNode(hasText(text))
        if (runCatching { node.assertIsDisplayed() }.isSuccess) return
        composeRule.onNode(hasScrollToIndexAction())
            .performScrollToNode(hasText(text))
        // A tall account card can be composed while its requested child remains
        // below the viewport. Bring that exact child into view after composing it.
        composeRule.onNode(hasText(text)).performScrollTo()
    }

    private fun captureAccountOverview(fileName: String) {
        composeRule.onNode(hasScrollToIndexAction()).performScrollToIndex(0)
        composeRule.captureUiRefinementScreenshot(fileName)
    }

    private fun awaitSecurityDataReady() {
        // Identities and sessions are installed together when the automatic refresh ends.
        // Wait for the actual enabled action before scanning the stable account list.
        scrollAccountTo("刷新")
        composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) {
            runCatching {
                composeRule.onNode(hasClickAction() and hasText("刷新")).assertIsEnabled()
            }.isSuccess
        }
    }

    private fun captureEmptyInputWithKeyboard(
        scenario: ActivityScenario<MainActivity>,
        inputLabel: String,
        fileName: String,
    ) {
        val input = composeRule.onNode(hasSetTextAction() and hasText(inputLabel))
        input.performScrollTo().assertIsDisplayed().performClick()
        scenario.onActivity { activity ->
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                .show(WindowInsetsCompat.Type.ime())
        }
        awaitKeyboardVisibility(scenario, visible = true)
        input.performScrollTo().assertIsDisplayed()
        var imeTopOnScreen = 0
        scenario.onActivity { activity ->
            val decorView = activity.window.decorView
            val insets = checkNotNull(ViewCompat.getRootWindowInsets(decorView))
            assertTrue(
                "The IME must still be visible immediately before capture",
                insets.isVisible(WindowInsetsCompat.Type.ime()),
            )
            val imeHeight = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            assertTrue(
                "The fixture requires a docked keyboard with a measurable height",
                imeHeight > 0,
            )
            imeTopOnScreen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                activity.windowManager.currentWindowMetrics.bounds.bottom - imeHeight
            } else {
                // Before API 30, the visible display frame excludes the docked IME.
                Rect().also(decorView::getWindowVisibleDisplayFrame).bottom
            }
        }
        val inputNode = input.fetchSemanticsNode()
        val inputBottomOnScreen = inputNode.positionOnScreen.y + inputNode.size.height
        assertTrue(
            "The input bottom ($inputBottomOnScreen px) must not extend below " +
                "the IME top ($imeTopOnScreen px)",
            inputNode.size.height > 0 && inputBottomOnScreen <= imeTopOnScreen,
        )
        // Capture before typing so the keyboard proof contains no account input or OTP.
        composeRule.captureUiRefinementScreenshot(fileName)
    }

    private fun awaitInputKeyboardIdle(scenario: ActivityScenario<MainActivity>) {
        // Email and numeric input can resize the IME after text input has completed.
        // Keep the actual keyboard open for action reachability, including when the
        // next challenge field was focused through a semantics text-input action.
        scenario.onActivity { activity ->
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                .show(WindowInsetsCompat.Type.ime())
        }
        awaitKeyboardVisibility(scenario, visible = true)
        InstrumentationRegistry.getInstrumentation().uiAutomation.waitForIdle(500L, 5_000L)
        composeRule.waitForIdle()
    }

    private fun awaitKeyboardVisibility(
        scenario: ActivityScenario<MainActivity>,
        visible: Boolean,
    ) {
        composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) {
            var visibilityMatches = false
            scenario.onActivity { activity ->
                visibilityMatches = ViewCompat.getRootWindowInsets(activity.window.decorView)
                    ?.isVisible(WindowInsetsCompat.Type.ime()) == visible
            }
            visibilityMatches
        }
    }

    private fun awaitText(text: String) {
        try {
            composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) { hasUiText(text) }
        } catch (error: ComposeTimeoutException) {
            throw AssertionError("Auth fixture timeout; ${authFailureDiagnostics()}", error)
        }
    }

    private fun authFailureDiagnostics(): String {
        // Only fixed route counts and synthetic counters enter failure output.
        val routeCounts = listOf(
            "GET" to "/v1/config",
            "POST" to "/v1/auth/phone/request-code",
            "POST" to "/v1/auth/email/request-code",
            "POST" to "/v1/auth/login",
            "GET" to "/v1/auth/identities",
            "GET" to "/v1/auth/sessions",
            "POST" to "/v1/auth/identities",
            "POST" to "/v1/auth/logout",
        ).joinToString { (method, path) ->
            "$method $path=${requests.count { it.method == method && it.path == path }}"
        }
        return "routeCounts=[$routeCounts]; loginCount=${loginCount.get()}; " +
            "emailBound=${emailBound.get()}"
    }

    private fun awaitRequestCount(expected: Int) {
        composeRule.waitUntil(timeoutMillis = UI_TIMEOUT_MS) { requests.size >= expected }
    }

    private fun hasUiText(text: String): Boolean = composeRule.onAllNodesWithText(
        text = text,
        useUnmergedTree = true,
    ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    private fun assertTransportContract() {
        assertTrue("账号夹具必须收到请求", requests.isNotEmpty())
        requests.forEach { request ->
            assertEquals(
                "${request.method} ${request.path} 缺少 API 契约头",
                API_CONTRACT_VERSION,
                request.contractVersion,
            )
        }

        val expectedOrder = listOf(
            ExpectedRequest("GET", "/v1/config", null),
            ExpectedRequest("POST", "/v1/auth/phone/request-code", null),
            ExpectedRequest("POST", "/v1/auth/login", null),
            ExpectedRequest("GET", "/v1/auth/identities", "Bearer $ACCESS_TOKEN_ONE"),
            ExpectedRequest("GET", "/v1/auth/sessions", "Bearer $ACCESS_TOKEN_ONE"),
            ExpectedRequest("POST", "/v1/auth/email/request-code", "Bearer $ACCESS_TOKEN_ONE"),
            ExpectedRequest("POST", "/v1/auth/identities", "Bearer $ACCESS_TOKEN_ONE"),
            ExpectedRequest("GET", "/v1/auth/identities", "Bearer $ACCESS_TOKEN_ONE"),
            ExpectedRequest("GET", "/v1/auth/sessions", "Bearer $ACCESS_TOKEN_ONE"),
            ExpectedRequest("POST", "/v1/auth/logout", "Bearer $ACCESS_TOKEN_ONE"),
            ExpectedRequest("POST", "/v1/auth/email/request-code", null),
            ExpectedRequest("POST", "/v1/auth/login", null),
            ExpectedRequest("GET", "/v1/auth/identities", "Bearer $ACCESS_TOKEN_TWO"),
            ExpectedRequest("GET", "/v1/auth/sessions", "Bearer $ACCESS_TOKEN_TWO"),
            ExpectedRequest("POST", "/v1/auth/logout", "Bearer $ACCESS_TOKEN_TWO"),
        )
        assertEquals(
            "账号夹具请求必须无缺失、无重复且严格按交互顺序发送",
            expectedOrder,
            requests.map { ExpectedRequest(it.method, it.path, it.authorization) },
        )

        assertTrue("配置 GET 不得携带请求体", requests[0].body.isEmpty())
        val installationId = jsonField(requests[1].body, "installationId")
        assertEquals(
            "installationId 必须是规范 UUID",
            installationId,
            UUID.fromString(installationId).toString(),
        )
        val appVersion = readMainBuildConfigString("VERSION_NAME").substringBefore('-')

        assertExactJson(
            label = "手机号验证码请求",
            actual = requests[1].body,
            expected = """{
                "phoneNumber":"$PHONE_NUMBER",
                "purpose":"REGISTER",
                "installationId":"$installationId"
            }""",
        )
        assertExactJson(
            label = "手机号验证码登录请求",
            actual = requests[2].body,
            expected = loginBody(
                method = "PHONE",
                challengeId = PHONE_CHALLENGE_ID,
                installationId = installationId,
                appVersion = appVersion,
                phoneNumber = PHONE_NUMBER,
            ),
        )
        assertTrue("身份列表 GET 不得携带请求体", requests[3].body.isEmpty())
        assertTrue("会话列表 GET 不得携带请求体", requests[4].body.isEmpty())
        assertExactJson(
            label = "邮箱绑定验证码请求",
            actual = requests[5].body,
            expected = """{
                "email":"$EMAIL",
                "purpose":"BIND",
                "installationId":"$installationId"
            }""",
        )
        assertExactJson(
            label = "邮箱绑定请求",
            actual = requests[6].body,
            expected = """{
                "type":"EMAIL",
                "challengeId":"$EMAIL_BIND_CHALLENGE_ID",
                "otpCode":"$OTP"
            }""",
        )
        assertTrue("绑定后身份列表 GET 不得携带请求体", requests[7].body.isEmpty())
        assertTrue("绑定后会话列表 GET 不得携带请求体", requests[8].body.isEmpty())
        assertExactJson("第一次退出请求", requests[9].body, "{}")
        assertExactJson(
            label = "邮箱登录验证码请求",
            actual = requests[10].body,
            expected = """{
                "email":"$EMAIL",
                "purpose":"LOGIN",
                "installationId":"$installationId"
            }""",
        )
        assertExactJson(
            label = "邮箱验证码登录请求",
            actual = requests[11].body,
            expected = loginBody(
                method = "EMAIL",
                challengeId = EMAIL_LOGIN_CHALLENGE_ID,
                installationId = installationId,
                appVersion = appVersion,
            ),
        )
        assertTrue("第二次身份列表 GET 不得携带请求体", requests[12].body.isEmpty())
        assertTrue("第二次会话列表 GET 不得携带请求体", requests[13].body.isEmpty())
        assertExactJson("第二次退出请求", requests[14].body, "{}")

        assertFalse("关闭态设备测试不得请求 OAuth state", requests.any { it.path == "/v1/auth/oauth/state" })
    }

    private fun loginBody(
        method: String,
        challengeId: String,
        installationId: String,
        appVersion: String,
        phoneNumber: String? = null,
    ): String {
        val phoneField = phoneNumber?.let { ",\n        \"phoneNumber\":\"$it\"" }.orEmpty()
        return """{
        "method":"$method",
        "device":{
            "installationId":"$installationId",
            "label":"Android 设备",
            "platform":"ANDROID",
            "appVersion":"$appVersion"
        },
        "challengeId":"$challengeId",
        "otpCode":"$OTP"$phoneField
    }"""
    }

    private fun assertExactJson(label: String, actual: String, expected: String) {
        assertEquals(
            "$label JSON 字段、类型和值必须完全一致",
            Json.parseToJsonElement(expected),
            Json.parseToJsonElement(actual),
        )
    }

    private fun jsonField(body: String, name: String): String = Json
        .parseToJsonElement(body)
        .jsonObject
        .getValue(name)
        .jsonPrimitive
        .content

    private fun authDispatcher(): Dispatcher = object : Dispatcher() {
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
                "POST" to "/v1/auth/phone/request-code" ->
                    contractResponse(200).setBody(challengeBody(PHONE_CHALLENGE_ID, "PHONE", PHONE_MASK))
                "POST" to "/v1/auth/email/request-code" -> {
                    val purpose = runCatching { jsonField(body, "purpose") }.getOrNull()
                    val challengeId = if (purpose == "BIND") EMAIL_BIND_CHALLENGE_ID else EMAIL_LOGIN_CHALLENGE_ID
                    contractResponse(200).setBody(challengeBody(challengeId, "EMAIL", EMAIL_MASK))
                }
                "POST" to "/v1/auth/login" -> {
                    val ordinal = loginCount.incrementAndGet()
                    contractResponse(200).setBody(tokenBody(ordinal))
                }
                "GET" to "/v1/auth/identities" ->
                    contractResponse(200).setBody(identitiesBody())
                "GET" to "/v1/auth/sessions" ->
                    contractResponse(200).setBody(sessionsBody())
                "POST" to "/v1/auth/identities" -> {
                    emailBound.set(true)
                    contractResponse(200).setBody("""{"binding":${emailBindingBody()}}""")
                }
                "POST" to "/v1/auth/logout" ->
                    contractResponse(200).setBody(logoutBody())
                else -> contractResponse(404).setBody("""{"error":"unexpected test request"}""")
            }
        }
    }

    private fun configurationBody(): String = """
        {
          "coverageName":"全国服务",
          "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "aiEnabled":false,
          "accountsEnabled":true,
          "favoritesEnabled":false,
          "supportFeedbackEnabled":false,
          "minimumSupportedVersion":"0.1.1",
          "ruleVersion":"rule-auth-fixture-v1",
          "promptVersion":"prompt-disabled",
          "modelVersion":"rule-auth-fixture-v1",
          "authCapabilities":{
            "accountsEnabled":true,
            "registrationEnabled":true,
            "phoneEnabled":true,
            "wechatEnabled":true,
            "emailEnabled":true,
            "qqEnabled":true,
            "dataExportEnabled":false
          }
        }
    """.trimIndent()

    private fun challengeBody(id: String, type: String, mask: String): String {
        val now = Instant.now()
        return """
            {
              "challengeId":"$id",
              "targetType":"$type",
              "maskedTarget":"$mask",
              "expiresAt":"${now.plus(5, ChronoUnit.MINUTES)}",
              "resendAvailableAt":"${now.plus(1, ChronoUnit.MINUTES)}"
            }
        """.trimIndent()
    }

    private fun tokenBody(ordinal: Int): String {
        val now = Instant.now()
        val second = ordinal > 1
        return """
            {
              "userId":"$USER_ID",
              "sessionId":"${if (second) SESSION_ID_TWO else SESSION_ID_ONE}",
              "tokenType":"Bearer",
              "accessToken":"${if (second) ACCESS_TOKEN_TWO else ACCESS_TOKEN_ONE}",
              "accessTokenExpiresAt":"${now.plus(15, ChronoUnit.MINUTES)}",
              "refreshToken":"${if (second) REFRESH_TOKEN_TWO else REFRESH_TOKEN_ONE}",
              "refreshTokenExpiresAt":"${now.plus(30, ChronoUnit.DAYS)}"
            }
        """.trimIndent()
    }

    private fun identitiesBody(): String {
        val email = if (emailBound.get()) ",${emailBindingBody()}" else ""
        return """
            {"items":[
              {
                "bindingId":"$PHONE_BINDING_ID",
                "type":"PHONE",
                "maskedValue":"$PHONE_MASK",
                "boundAt":"2026-08-22T00:00:00Z",
                "primary":true,
                "canUnbind":false
              },
              {
                "bindingId":"$WECHAT_BINDING_ID",
                "type":"WECHAT",
                "maskedValue":"微信账号",
                "boundAt":"2026-08-22T00:00:00Z",
                "primary":false,
                "canUnbind":false
              }
              $email
            ]}
        """.trimIndent()
    }

    private fun emailBindingBody(): String = """
        {
          "bindingId":"$EMAIL_BINDING_ID",
          "type":"EMAIL",
          "maskedValue":"$EMAIL_MASK",
          "boundAt":"2026-08-22T00:05:00Z",
          "primary":false,
          "canUnbind":true
        }
    """.trimIndent()

    private fun sessionsBody(): String {
        val now = Instant.now()
        val sessionId = if (loginCount.get() > 1) SESSION_ID_TWO else SESSION_ID_ONE
        return """
            {"items":[{
              "sessionId":"$sessionId",
              "deviceLabel":"Android 设备",
              "platform":"ANDROID",
              "current":true,
              "createdAt":"${now.minus(1, ChronoUnit.MINUTES)}",
              "lastActiveAt":"$now",
              "expiresAt":"${now.plus(30, ChronoUnit.DAYS)}"
            }]}
        """.trimIndent()
    }

    private fun logoutBody(): String {
        val sessionId = if (loginCount.get() > 1) SESSION_ID_TWO else SESSION_ID_ONE
        return """{"sessionId":"$sessionId","loggedOutAt":"${Instant.now()}"}"""
    }

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

    private data class ExpectedRequest(
        val method: String,
        val path: String,
        val authorization: String?,
    )

    private companion object {
        const val OPT_IN_ARGUMENT = "authLocalFixture"
        const val DEVICE_LOOPBACK = "127.0.0.1"
        const val DEVICE_API_PORT = 3001
        const val PREFERENCES_FILE = "app_preferences.preferences_pb"
        const val UI_TIMEOUT_MS = 20_000L
        const val GUEST_ACCOUNT_ITEM_COUNT = 4
        const val SIGNED_IN_WITH_EMAIL_BIND_ITEM_COUNT = 7
        const val SIGNED_IN_EMAIL_BOUND_ITEM_COUNT = 7
        const val PHONE_NUMBER = "+8613800138000"
        const val PHONE_MASK = "+86138****8000"
        const val EMAIL = "user@example.com"
        const val EMAIL_MASK = "u***@example.com"
        const val OTP = "123456"
        const val USER_ID = "10000000-0000-4000-8000-000000000001"
        const val SESSION_ID_ONE = "20000000-0000-4000-8000-000000000001"
        const val SESSION_ID_TWO = "20000000-0000-4000-8000-000000000002"
        const val PHONE_BINDING_ID = "30000000-0000-4000-8000-000000000001"
        const val WECHAT_BINDING_ID = "30000000-0000-4000-8000-000000000002"
        const val EMAIL_BINDING_ID = "30000000-0000-4000-8000-000000000003"
        const val PHONE_CHALLENGE_ID = "40000000-0000-4000-8000-000000000001"
        const val EMAIL_BIND_CHALLENGE_ID = "40000000-0000-4000-8000-000000000002"
        const val EMAIL_LOGIN_CHALLENGE_ID = "40000000-0000-4000-8000-000000000003"
        const val ACCESS_TOKEN_ONE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        const val REFRESH_TOKEN_ONE = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        const val ACCESS_TOKEN_TWO = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
        const val REFRESH_TOKEN_TWO = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
    }
}
