package com.chishenme.app

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
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
        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        // ChiShenMeApplication does not initialize DataStore. Deleting the exact backing
        // file before MainActivity launches is therefore deterministic and avoids adding
        // a test-only Hilt entry point or replacing the production dependency graph.
        val preferencesFile = application.preferencesDataStoreFile(
            "app_preferences.preferences_pb",
        )
        assertTrue(
            "无法重置首次启动状态：${preferencesFile.absolutePath}",
            !preferencesFile.exists() || preferencesFile.delete(),
        )
    }

    @Test
    fun firstLaunch_manualDemoLocation_opensPrimaryDetailAndReturnsToResults() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            // The production DataStore is process-scoped. When this test follows
            // another activity test, deleting its backing file cannot rewind the
            // already-open singleton, so accept consent only when it is present.
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("同意并继续") || hasText("手动选择")
            }
            if (hasText("同意并继续")) {
                composeRule.onNodeWithText("同意并继续").assertIsDisplayed().performClick()
            }

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("手动选择")
            }
            composeRule.onNodeWithText("吃什么").assertIsDisplayed()
            composeRule.onNodeWithText("现在这一顿，30 秒决定").assertIsDisplayed()
            composeRule.onNodeWithText("手动选择").assertIsDisplayed().performClick()

            composeRule.onNodeWithText("快捷地点（始终可用）")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText(MANUAL_LOCATION)
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.onNodeWithText(MANUAL_LOCATION).assertIsDisplayed()
            composeRule.onNodeWithText("当前极速条件")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText("帮我决定")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = RECOMMENDATION_TIMEOUT_MS) {
                hasText("推荐结果") || hasText("这次没决定出来")
            }

            if (hasText("这次没决定出来")) {
                composeRule.onNodeWithText("这次没决定出来").assertIsDisplayed()
                val diagnostic = DIAGNOSTIC_MESSAGES.firstOrNull { message -> hasText(message) }
                    ?: "错误页未提供已知诊断信息"
                composeRule.onNodeWithText("重新尝试").assertIsDisplayed()
                composeRule.onNodeWithText("返回调整条件").assertIsDisplayed()
                fail("本地 DEMO 推荐验收失败，界面诊断：$diagnostic")
            }

            composeRule.onNodeWithText("推荐结果").assertIsDisplayed()
            composeRule.onNodeWithText("主推荐")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onAllNodesWithText("虚构演示数据", substring = true)[0]
                .performScrollTo()
                .assertIsDisplayed()
            assertTrue(
                "DEMO 后端应返回至少一个明确标注的虚构餐厅",
                DEMO_RESTAURANT_NAMES.any { name -> hasText(name) },
            )

            composeRule.onNodeWithText("仅营业中")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
                .assertIsSelected()
            composeRule.onNodeWithText("附近方位图")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
                .assertIsSelected()

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("推荐结果") || hasText(RECOMMENDATION_EXPIRED_MARKER)
            }
            if (hasText(RECOMMENDATION_EXPIRED_MARKER)) {
                fail("Activity 重建后推荐结果会话意外失效")
            }
            composeRule.onNodeWithText("仅营业中").assertIsSelected()
            composeRule.onNodeWithText("附近方位图").assertIsSelected()
            composeRule.onNodeWithText("附近方位图（非道路导航图）")
                .performScrollTo()
                .assertIsDisplayed()

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
                fail("打开主推荐后详情会话意外失效")
            }

            composeRule.onNodeWithText("餐厅详情").assertIsDisplayed()
            composeRule.onNodeWithText(PRIMARY_DEMO_RESTAURANT).assertIsDisplayed()
            composeRule.onNodeWithText(DEMO_ADDRESS).assertIsDisplayed()
            composeRule.onNodeWithText("地图查询").assertIsDisplayed()
            composeRule.onNodeWithText("复制地址").assertIsDisplayed()

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("餐厅详情") || hasText(DETAIL_EXPIRED_MARKER)
            }
            if (hasText(DETAIL_EXPIRED_MARKER)) {
                fail("Activity 重建后推荐详情会话意外失效")
            }
            composeRule.onNodeWithText("餐厅详情").assertIsDisplayed()
            composeRule.onNodeWithText(PRIMARY_DEMO_RESTAURANT).assertIsDisplayed()
            composeRule.onNodeWithText(DEMO_ADDRESS).assertIsDisplayed()

            composeRule.onNodeWithText(DEMO_DATA_SOURCE)
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText(
                "分享推荐卡",
                substring = true,
                useUnmergedTree = true,
            ).assertDoesNotExist()
            composeRule.onNodeWithText("营业状态：营业中")
                .performScrollTo()
                .assertIsDisplayed()

            composeRule.onNodeWithText(DEMO_DETAIL_WARNING)
                .performScrollTo()

            composeRule.onNodeWithContentDescription("返回推荐结果")
                .assertIsDisplayed()
                .performClick()
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("本次用餐候选") || hasText(RECOMMENDATION_EXPIRED_MARKER)
            }
            if (hasText(RECOMMENDATION_EXPIRED_MARKER)) {
                fail("从重建后的详情返回时推荐结果会话意外失效")
            }
            composeRule.onNodeWithText("本次用餐候选").assertIsDisplayed()
            composeRule.onNode(hasScrollToIndexAction()).performScrollToNode(
                androidx.compose.ui.test.hasText("仅营业中"),
            )
            composeRule.onNodeWithText("仅营业中").assertIsSelected()
            composeRule.onNode(hasScrollToIndexAction()).performScrollToNode(
                androidx.compose.ui.test.hasText("附近方位图"),
            )
            composeRule.onNodeWithText("附近方位图").assertIsSelected()
            composeRule.onNode(hasScrollToIndexAction()).performScrollToNode(
                androidx.compose.ui.test.hasText("附近方位图（非道路导航图）"),
            )
            composeRule.onNodeWithText("附近方位图（非道路导航图）")
                .assertIsDisplayed()
        }
    }

    @Test
    fun firstLaunch_supportFeedbackDisabled_hasNoSubmissionEntry() {
        ActivityScenario.launch(MainActivity::class.java).use {
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("同意并继续") || hasText("手动选择")
            }
            if (hasText("同意并继续")) {
                composeRule.onNodeWithText("同意并继续").assertIsDisplayed().performClick()
            }

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("手动选择")
            }
            composeRule.onNodeWithContentDescription("设置")
                .assertIsDisplayed()
                .performClick()

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("设置与透明度")
            }
            composeRule.onNodeWithText("问题反馈与餐厅纠错")
                .performScrollTo()
                .assertIsDisplayed()
            composeRule.onNodeWithText("反馈服务尚未完成就绪确认，当前不会开放任何提交入口。")
                .performScrollTo()
                .assertIsDisplayed()
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
                hasText("同意并继续") || hasText("手动选择")
            }
            if (hasText("同意并继续")) {
                composeRule.onNodeWithText("同意并继续").assertIsDisplayed().performClick()
            }

            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("手动选择")
            }
            assertFalse("正常首页不应显示直接餐厅搜索卡片", hasText("已经知道想吃什么？"))
            assertFalse(
                "正常首页不应显示直接餐厅搜索入口",
                hasText("搜索附近餐厅 / 菜系 / 食物"),
            )
            composeRule.onNodeWithText("手动选择").assertIsDisplayed().performClick()
            composeRule.onNodeWithText("搜索或选择地点").assertIsDisplayed()
            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                hasText("搜索地点")
            }
            composeRule.onNode(hasSetTextAction())
                .assertIsDisplayed()
                .performTextInput(LOCATION_SEARCH_QUERY)

            recreateActivity(scenario)
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("搜索或选择地点")
            }
            composeRule.onNode(hasSetTextAction())
                .assertIsDisplayed()
                .assertTextContains(LOCATION_SEARCH_QUERY)
            composeRule.onNodeWithText("搜索地点")
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
            composeRule.onNodeWithText("演示位置只在本次会话使用，不会写入历史。")
                .assertIsDisplayed()
            composeRule.onNodeWithText("帮我决定")
                .performScrollTo()
                .assertIsDisplayed()
            assertFalse("选择地点后也不应显示直接餐厅搜索卡片", hasText("已经知道想吃什么？"))
            assertFalse(
                "选择地点后也不应显示直接餐厅搜索入口",
                hasText("搜索附近餐厅 / 菜系 / 食物"),
            )
        }
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
