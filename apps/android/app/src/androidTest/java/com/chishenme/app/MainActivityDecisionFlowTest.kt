package com.chishenme.app

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.chishenme.app.feature.consent.ConsentViewModel
import com.chishenme.app.feature.decision.DecisionViewModel
import com.chishenme.app.feature.decision.RecommendationLoadState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Emulator acceptance test for the real launcher activity and production Hilt graph.
 *
 * The test deliberately does not replace Retrofit: with `adb reverse tcp:3001 tcp:3001`
 * it exercises the local development API and its DEMO provider. When that backend is
 * absent or unhealthy, the test fails with the exact user-visible diagnostic. It never
 * invokes location permissions, OAuth, persistence or feedback endpoints.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityDecisionFlowTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    @Before
    fun resetToFirstLaunch() {
        // DataStore remains open for the instrumentation process. Deleting its backing
        // file between methods can revoke consent after the next screen has opened.
        // Use the production Activity-scoped consent contract to reset this synthetic
        // app, then require a genuine consent screen before the test Activity starts.
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var consentViewModel: ConsentViewModel
            scenario.onActivity { activity ->
                consentViewModel = ViewModelProvider(activity)[ConsentViewModel::class.java]
                consentViewModel.withdrawPrivacy {}
            }
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                consentViewModel.privacyAccepted.value == false && hasText("同意并继续")
            }
            composeRule.onNodeWithText("同意并继续")
                .performScrollTo()
                .assertIsDisplayed()
        }
    }

    @Test
    fun firstLaunch_manualDemoLocation_opensPrimaryDetailAndReturnsToResults() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var decisionViewModel: DecisionViewModel
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("同意并继续")
            }
            composeRule.onNodeWithText("同意并继续")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("帮我选")
            }
            scenario.onActivity { activity ->
                decisionViewModel = ViewModelProvider(activity)[DecisionViewModel::class.java]
            }
            composeRule.onNodeWithText("帮我选").assertIsDisplayed()
            composeRule.onNodeWithText("附近美食，少一点纠结").assertDoesNotExist()
            composeRule.homeManualLocationAction()
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.onNodeWithText("快捷地点（始终可用）")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText(MANUAL_LOCATION)
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.onNodeWithText(MANUAL_LOCATION).assertIsDisplayed()
            composeRule.openHomeConditions()
            scrollListTo("当前极速条件")
            composeRule.onNodeWithText("当前极速条件")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.closeHomePanel()
            composeRule.onNodeWithText("帮我选")
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = RECOMMENDATION_TIMEOUT_MS) {
                (composeRule.onNodeWithText(RESULTS_HEADING).isDisplayed() &&
                    decisionViewModel.uiState.value.loadState is RecommendationLoadState.Ready) ||
                    hasText("这次没决定出来")
            }

            if (hasText("这次没决定出来")) {
                composeRule.onNodeWithText("这次没决定出来").assertIsDisplayed()
                val diagnostic = DIAGNOSTIC_MESSAGES.firstOrNull { message -> hasText(message) }
                    ?: "错误页未提供已知诊断信息"
                composeRule.onNodeWithText("重新尝试").assertIsDisplayed()
                composeRule.onNodeWithText("返回调整条件").assertIsDisplayed()
                fail("本地 DEMO 推荐验收失败，界面诊断：$diagnostic")
            }

            composeRule.onNodeWithText(RESULTS_HEADING).assertIsDisplayed()
            scrollListTo("首个候选")
            composeRule.onNodeWithText("首个候选")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText("主推荐").assertDoesNotExist()
            scrollListTo("虚构演示数据", substring = true)
            composeRule.onAllNodesWithText("虚构演示数据", substring = true)[0]
                .performScrollTo()
                .assertIsDisplayed()
            assertTrue(
                "DEMO 后端应返回至少一个明确标注的虚构餐厅",
                DEMO_RESTAURANT_NAMES.any { name -> hasText(name) },
            )

            scrollListTo("仅营业中")
            composeRule.onNodeWithText("仅营业中")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
                .assertIsSelected()
            assertListOnlyPresentation()

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                (composeRule.onNodeWithText(RESULTS_HEADING).isDisplayed() &&
                    decisionViewModel.uiState.value.loadState is RecommendationLoadState.Ready) ||
                    hasText(RECOMMENDATION_EXPIRED_MARKER)
            }
            if (hasText(RECOMMENDATION_EXPIRED_MARKER)) {
                fail("Activity 重建后推荐结果会话意外失效")
            }
            composeRule.onNodeWithText(RESULTS_HEADING).assertIsDisplayed()
            scrollListTo("仅营业中")
            composeRule.onNodeWithText("仅营业中").assertIsSelected()
            assertListOnlyPresentation()

            scrollListTo(PRIMARY_DEMO_RESTAURANT, substring = true)
            composeRule.onNode(
                hasClickAction() and
                    androidx.compose.ui.test.hasText(
                        PRIMARY_DEMO_RESTAURANT,
                        substring = true,
                    ),
            )
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("餐厅详情") || hasText("详情会话已失效")
            }
            if (hasText("详情会话已失效")) {
                fail("打开首个候选后详情会话意外失效")
            }

            composeRule.onNodeWithText("餐厅详情").assertIsDisplayed()
            for (text in listOf(PRIMARY_DEMO_RESTAURANT, DEMO_ADDRESS, "地图查询", "复制地址")) {
                scrollListTo(text)
                composeRule.onNodeWithText(text).performScrollTo().assertIsDisplayed()
            }

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("餐厅详情") || hasText(DETAIL_EXPIRED_MARKER)
            }
            if (hasText(DETAIL_EXPIRED_MARKER)) {
                fail("Activity 重建后推荐详情会话意外失效")
            }
            composeRule.onNodeWithText("餐厅详情").assertIsDisplayed()
            for (text in listOf(PRIMARY_DEMO_RESTAURANT, DEMO_ADDRESS)) {
                scrollListTo(text)
                composeRule.onNodeWithText(text).performScrollTo().assertIsDisplayed()
            }

            scrollListTo(DEMO_DATA_SOURCE)
            composeRule.onNodeWithText(DEMO_DATA_SOURCE)
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText(
                "分享推荐卡",
                substring = true,
                useUnmergedTree = true,
            ).assertDoesNotExist()
            scrollListTo("营业状态：营业中")
            composeRule.onNodeWithText("营业状态：营业中")
                .performScrollTo()
                .assertIsDisplayed()

            scrollListTo(DEMO_DETAIL_WARNING)
            composeRule.onNodeWithText(DEMO_DETAIL_WARNING)
                .performScrollTo()
                .assertIsDisplayed()

            composeRule.onNodeWithContentDescription("返回推荐结果")
                .assertIsDisplayed()
                .performClick()
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                (composeRule.onNodeWithText(RESULTS_HEADING).isDisplayed() &&
                    decisionViewModel.uiState.value.loadState is RecommendationLoadState.Ready) ||
                    hasText(RECOMMENDATION_EXPIRED_MARKER)
            }
            if (hasText(RECOMMENDATION_EXPIRED_MARKER)) {
                fail("从重建后的详情返回时推荐结果会话意外失效")
            }
            composeRule.onNodeWithText(RESULTS_HEADING).assertIsDisplayed()
            scrollListTo("仅营业中")
            composeRule.onNodeWithText("仅营业中")
                .performScrollTo()
                .assertIsDisplayed()
                .assertIsSelected()
            assertListOnlyPresentation()
            scrollListTo("本次结果筛选")
            composeRule.captureUiRefinementScreenshot("results-list-only.png")
        }
    }

    private fun assertListOnlyPresentation() {
        composeRule.onNodeWithText("列表").assertDoesNotExist()
        composeRule.onNodeWithText("附近方位图").assertDoesNotExist()
        scrollListTo("首个候选")
        composeRule.onNodeWithText("首个候选")
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithText("附近方位图（非道路导航图）").assertDoesNotExist()
    }

    @Test
    fun firstLaunch_supportFeedbackDisabled_hasNoSubmissionEntry() {
        ActivityScenario.launch(MainActivity::class.java).use {
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("同意并继续")
            }
            composeRule.onNodeWithText("同意并继续")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("帮我选")
            }
            composeRule.homeSettingsAction()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("设置与透明度")
            }
            scrollListTo("问题反馈与餐厅纠错")
            composeRule.onNodeWithText("问题反馈与餐厅纠错")
                .performScrollTo()
                .assertIsDisplayed()
            scrollListTo("反馈服务尚未完成就绪确认，当前不会开放任何提交入口。")
            composeRule.onNodeWithText("反馈服务尚未完成就绪确认，当前不会开放任何提交入口。")
                .performScrollTo()
                .assertIsDisplayed()
            scrollListTo("当前未开放")
            composeRule.onNodeWithText("当前未开放")
                .performScrollTo()
                .assertIsDisplayed()

            assertFalse(
                "反馈卡片标题不应携带点击动作",
                composeRule.onNodeWithText("问题反馈与餐厅纠错")
                    .fetchSemanticsNode()
                    .config
                    .contains(SemanticsActions.OnClick),
            )
            assertFalse(
                "未开放状态不应携带点击动作",
                composeRule.onNodeWithText("当前未开放")
                    .fetchSemanticsNode()
                    .config
                    .contains(SemanticsActions.OnClick),
            )

            // Exact-match assertions keep similarly worded explanatory copy from
            // being mistaken for an actionable feedback submission control.
            assertFalse("不应存在精确文本“提交”", hasText("提交"))
            assertFalse("不应进入问题反馈编辑页", hasText("问题反馈"))
            assertFalse("不应存在提交反馈按钮", hasText("提交反馈"))
            composeRule.onNodeWithText("设置与透明度").assertIsDisplayed()
        }
    }

    @Test
    fun firstLaunch_locationKeywordSearch_selectsDemoPlace_withoutRestaurantSearchEntry() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("同意并继续")
            }
            composeRule.onNodeWithText("同意并继续")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("帮我选")
            }
            assertFalse("正常首页不应显示直接餐厅搜索卡片", hasText("已经知道想吃什么？"))
            assertFalse(
                "正常首页不应显示直接餐厅搜索入口",
                hasText("搜索附近餐厅 / 菜系 / 食物"),
            )
            composeRule.homeManualLocationAction()
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
            composeRule.onNodeWithText("搜索或选择地点").assertIsDisplayed()
            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                hasText("搜索地点")
            }
            composeRule.onNode(hasSetTextAction())
                .performScrollTo()
                .assertIsDisplayed()
                .performTextInput(LOCATION_SEARCH_QUERY)

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("搜索或选择地点")
            }
            composeRule.onNode(hasSetTextAction())
                .performScrollTo()
                .assertIsDisplayed()
                .assertTextContains(LOCATION_SEARCH_QUERY)
            composeRule.onNodeWithText("搜索地点")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = LOCATION_SEARCH_TIMEOUT_MS) {
                hasText(DEMO_SEARCH_PLACE) ||
                    hasText("没有找到匹配地点，请换个关键词或使用快捷地点。") ||
                    LOCATION_SEARCH_DIAGNOSTICS.any(::hasText)
            }
            if (!hasText(DEMO_SEARCH_PLACE)) {
                val diagnostic = LOCATION_SEARCH_DIAGNOSTICS.firstOrNull(::hasText)
                    ?: "地点搜索没有返回预期演示地点"
                fail("本地 DEMO 地点搜索验收失败，界面诊断：$diagnostic")
            }

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = LOCATION_SEARCH_TIMEOUT_MS) {
                hasText(DEMO_SEARCH_PLACE) || LOCATION_SEARCH_DIAGNOSTICS.any(::hasText)
            }
            if (!hasText(DEMO_SEARCH_PLACE)) {
                val diagnostic = LOCATION_SEARCH_DIAGNOSTICS.firstOrNull(::hasText)
                    ?: "Activity 重建后地点搜索结果丢失"
                fail("Activity 重建后地点搜索结果未保留，界面诊断：$diagnostic")
            }
            composeRule.onNode(hasSetTextAction()).assertTextContains(LOCATION_SEARCH_QUERY)

            composeRule.onNodeWithText(DEMO_LOCATION_DISCLOSURE)
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText(DEMO_LOCATION_SOURCE_RANK)
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText(DEMO_SEARCH_PLACE)
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText(DEMO_SEARCH_PLACE)
            }
            composeRule.onNodeWithText(DEMO_SEARCH_PLACE).assertIsDisplayed()
            composeRule.onNodeWithTag("home-location").performClick()
            composeRule.onNode(
                androidx.compose.ui.test.hasText(DEMO_SEARCH_PLACE) and hasAnyAncestor(
                    androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollBy),
                ),
            ).performScrollTo().assertIsDisplayed()
            composeRule.onNodeWithText("演示位置只在本次会话使用，不会写入历史。")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.closeHomePanel()
            composeRule.onNodeWithText("帮我选")
                .assertIsDisplayed()
            assertFalse("选择地点后也不应显示直接餐厅搜索卡片", hasText("已经知道想吃什么？"))
            assertFalse(
                "选择地点后也不应显示直接餐厅搜索入口",
                hasText("搜索附近餐厅 / 菜系 / 食物"),
            )
        }
    }

    private fun scrollListTo(text: String, substring: Boolean = false) {
        composeRule.onNode(
            hasScrollToIndexAction() and !hasAnyAncestor(hasScrollToIndexAction()),
        ).performScrollToNode(
            androidx.compose.ui.test.hasText(text, substring = substring),
        )
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

    private fun hasText(text: String, substring: Boolean = false): Boolean =
        composeRule.onAllNodesWithText(
            text = text,
            substring = substring,
            useUnmergedTree = true,
        ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    companion object {
        private const val STARTUP_TIMEOUT_MS = 10_000L
        private const val CONFIG_TIMEOUT_MS = 20_000L
        private const val LOCATION_SEARCH_TIMEOUT_MS = 15_000L
        private const val RECOMMENDATION_TIMEOUT_MS = 20_000L
        private const val MANUAL_LOCATION = "北京大学东门"
        private const val RESULTS_HEADING = "本次用餐候选"
        private const val LOCATION_SEARCH_QUERY = "北京大学"
        private const val DEMO_SEARCH_PLACE = "演示·北京大学东门测试点"
        private const val DEMO_LOCATION_DISCLOSURE =
            "输入内容会发送给 虚构地点数据，仅供开发测试 用于本次搜索，不保存。"
        private const val DEMO_LOCATION_SOURCE_RANK =
            "来源：虚构地点数据，仅供开发测试 · 数据源顺序 1"
        private const val RECOMMENDATION_EXPIRED_MARKER =
            "推荐状态已失效，请返回首页重新选择条件"
        private const val DETAIL_EXPIRED_MARKER = "详情会话已失效"
        private const val PRIMARY_DEMO_RESTAURANT = "演示·校园面馆"
        private const val DEMO_ADDRESS = "虚构演示地址（不对应真实商户）"
        private const val DEMO_DATA_SOURCE = "数据来源：虚构演示数据，不可用于真实就餐决策"
        private const val DEMO_DETAIL_WARNING = "这是演示数据，不代表真实商户，请勿据此出行或联系。"

        private val DEMO_RESTAURANT_NAMES = listOf(
            "演示·校园面馆",
            "演示·家常盖饭",
            "演示·北方饺子铺",
            "演示·邻里食堂",
            "演示·湘味小馆",
            "演示·同学小火锅",
        )

        private val DIAGNOSTIC_MESSAGES = listOf(
            "网络不可用，请检查连接后重试",
            "推荐服务响应较慢，请稍后重试",
            "推荐条件有误，请调整后重试",
            "请求有点多，请稍后再试",
            "推荐服务暂时不可用，请稍后重试",
            "服务返回的数据未通过安全校验",
            "当前 App 与推荐服务版本不兼容，请更新 App 后重试",
            "服务返回的数据无法识别",
            "暂时无法生成推荐，请重试",
        )

        private val LOCATION_SEARCH_DIAGNOSTICS = listOf(
            "远程配置尚未完成可信校验，请重新检查后再试",
            "网络不可用，仍可选择下方内置地点",
            "地点关键词无法搜索，请换一种写法",
            "地点搜索响应较慢，请重试或选择内置地点",
            "搜索请求有点多，请稍后重试",
            "地点搜索服务暂时不可用，仍可选择内置地点",
            "地点搜索结果未通过安全校验，请重试",
            "地点搜索结果无法识别，请重试",
            "暂时无法搜索地点，仍可选择内置地点",
            "当前 App 与地点搜索服务版本不兼容，请更新 App 后重试",
        )
    }
}
