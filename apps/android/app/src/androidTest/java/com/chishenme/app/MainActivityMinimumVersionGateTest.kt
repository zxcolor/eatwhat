package com.chishenme.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Standalone emulator acceptance test for the process-wide minimum-version gate.
 *
 * Run this class separately while the local API advertises a minimum version
 * greater than [BuildConfig.VERSION_NAME]. Keeping it separate lets the normal
 * DEMO decision tests continue to use the compatible local configuration.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityMinimumVersionGateTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    @Before
    fun resetToFirstLaunch() {
        assumeTrue(
            "此用例只在显式启用高最低版本测试环境时运行",
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
    }

    @Test
    fun higherServerMinimumShowsOnlyLocalUpdateAndPrivacyControls() {
        ActivityScenario.launch(MainActivity::class.java).use {
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("同意并继续") || hasText(UPDATE_HEADING)
            }
            if (hasText("同意并继续")) {
                composeRule.onNodeWithText("同意并继续")
                    .assertIsDisplayed()
                    .performClick()
            }

            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                hasText(UPDATE_HEADING)
            }
            composeRule.onNodeWithText(UPDATE_HEADING).assertIsDisplayed()
            composeRule.onNodeWithText("版本信息").assertIsDisplayed()
            composeRule.onNodeWithText("当前版本：", substring = true).assertIsDisplayed()
            composeRule.onNodeWithText("最低支持版本：", substring = true).assertIsDisplayed()
            composeRule.onNodeWithText("重新检查").assertIsDisplayed()
            composeRule.onNodeWithText("撤回隐私同意").assertIsDisplayed()
            composeRule.onNodeWithText("数据权利").assertIsDisplayed()
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("本机未检测到可管理的登录状态。")
            }

            assertRemoteProductEntrancesAbsent()

            // A recheck against the same high minimum must not briefly restore
            // the old navigation graph or any remote product action.
            composeRule.onNodeWithText("重新检查").performClick()
            composeRule.waitUntil(timeoutMillis = CONFIG_TIMEOUT_MS) {
                hasText(UPDATE_HEADING)
            }
            composeRule.onNodeWithText(UPDATE_HEADING).assertIsDisplayed()
            assertRemoteProductEntrancesAbsent()

            // Privacy withdrawal is intentionally local and remains reachable
            // even when every remote product feature is version-gated.
            composeRule.onNodeWithText("撤回隐私同意").performClick()
            composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
                hasText("同意并继续")
            }
            composeRule.onNodeWithText("同意并继续").assertIsDisplayed()
        }
    }

    private fun assertRemoteProductEntrancesAbsent() {
        REMOTE_PRODUCT_TEXTS.forEach { text ->
            assertFalse("更新专页不应包含远程入口：$text", hasText(text))
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
        private const val UPDATE_HEADING = "需要更新后继续"
        private const val OPT_IN_ARGUMENT = "minimumVersionGate"

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
