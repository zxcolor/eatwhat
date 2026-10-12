package com.chishenme.app

import android.content.ContextWrapper
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText as hasSemanticsText
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
import androidx.test.espresso.intent.Intents
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.feature.decision.DecisionViewModel
import com.chishenme.app.feature.decision.RecommendationLoadState
import com.chishenme.app.feature.detail.AndroidRestaurantActions
import com.chishenme.app.feature.detail.RestaurantShareOutcome
import com.chishenme.app.feature.detail.toRestaurantDisplayModel
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android 1.0 acceptance for the sealed recommendation-card share boundary.
 *
 * The real local DEMO API advertises `actions.share=false`; its UI flow must render no
 * share entry, start no share Intent and create no temporary share-card file. A separate
 * direct-action test supplies a synthetic `actions.share=true` result to prove the hard close.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class MainActivityShareCardTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    @Before
    fun resetToFirstLaunch() {
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
    fun demoDetail_serverShareFalse_hasNoShareUiIntentOrNewCacheFile() {
        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        val shareDirectory = File(application.cacheDir, SHARE_DIRECTORY_NAME)
        val filesBefore = shareFileNames(shareDirectory)

        Intents.init()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                openPrimaryDemoRestaurant(scenario)

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
                composeRule.onNodeWithText(
                    "正在生成分享卡",
                    substring = true,
                    useUnmergedTree = true,
                ).assertDoesNotExist()
                composeRule.onNodeWithText(
                    "分享",
                    substring = true,
                    useUnmergedTree = true,
                ).assertDoesNotExist()
                composeRule.waitForIdle()

                val recordedShareActions = Intents.getIntents()
                    .mapNotNull(Intent::getAction)
                    .filter { action ->
                        action == Intent.ACTION_CHOOSER || action == Intent.ACTION_SEND
                    }
                assertTrue(
                    "Android 1.0 不得启动 chooser 或 ACTION_SEND：$recordedShareActions",
                    recordedShareActions.isEmpty(),
                )
                val newFiles = shareFileNames(shareDirectory) - filesBefore
                assertTrue("Android 1.0 不得生成临时分享文件：$newFiles", newFiles.isEmpty())
            }
        } finally {
            Intents.release()
        }
    }

    @Test
    fun shareApis_serverShareTrue_stopBeforeCacheAndIntentBoundary() = runBlocking {
        val application = ApplicationProvider.getApplicationContext<ChiShenMeApplication>()
        val shareDirectory = File(application.cacheDir, SHARE_DIRECTORY_NAME)
        val filesBefore = shareFileNames(shareDirectory)
        val context = ShareBoundaryContext(application)
        val result = demoRecommendation()
        assertTrue("API v1 验收夹具必须显式返回 actions.share=true", result.actions.share)

        assertEquals(
            RestaurantShareOutcome.NOT_ALLOWED,
            AndroidRestaurantActions.share(context, result),
        )
        assertFalse(
            AndroidRestaurantActions.shareText(context, result.toRestaurantDisplayModel()),
        )
        assertEquals("硬关闭必须发生在读取 cacheDir 前", 0, context.cacheDirectoryAccesses)
        assertEquals("硬关闭必须发生在构造 FileProvider authority 前", 0, context.packageNameAccesses)
        assertEquals("硬关闭不得启动任何分享 Intent", 0, context.launchAttempts)
        val newFiles = shareFileNames(shareDirectory) - filesBefore
        assertTrue("直接动作调用不得生成临时分享文件：$newFiles", newFiles.isEmpty())
    }

    private fun openPrimaryDemoRestaurant(scenario: ActivityScenario<MainActivity>) {
        composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
            hasText("同意并继续") || hasText("帮我选")
        }
        if (hasText("同意并继续")) {
            composeRule.onNodeWithText("同意并继续")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
        }

        composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) { hasText("帮我选") }
        lateinit var decisionViewModel: DecisionViewModel
        scenario.onActivity { activity ->
            decisionViewModel = ViewModelProvider(activity)[DecisionViewModel::class.java]
        }
        composeRule.homeManualLocationAction()
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        composeRule.onNodeWithText(MANUAL_LOCATION)
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        composeRule.onNodeWithText("帮我选")
            .assertIsDisplayed()
            .performClick()

        composeRule.waitUntil(timeoutMillis = RECOMMENDATION_TIMEOUT_MS) {
            (hasText("本次用餐候选") &&
                decisionViewModel.uiState.value.loadState is RecommendationLoadState.Ready) ||
                hasText("这次没决定出来")
        }
        if (hasText("这次没决定出来")) {
            val diagnostic = RECOMMENDATION_DIAGNOSTICS.firstOrNull(::hasText)
                ?: "错误页未提供已知诊断信息"
            fail("本地 DEMO 分享验收无法取得推荐，界面诊断：$diagnostic")
        }

        composeRule.onNode(hasScrollToIndexAction()).performScrollToNode(
            hasClickAction() and hasSemanticsText(PRIMARY_DEMO_RESTAURANT, substring = true),
        )
        composeRule.onNode(
            hasClickAction() and hasSemanticsText(PRIMARY_DEMO_RESTAURANT, substring = true),
        )
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        composeRule.waitUntil(timeoutMillis = STARTUP_TIMEOUT_MS) {
            hasText("餐厅详情") || hasText(DETAIL_EXPIRED_MARKER)
        }
        if (hasText(DETAIL_EXPIRED_MARKER)) {
            fail("打开 DEMO 首个候选后详情会话意外失效")
        }
        composeRule.onNodeWithText(PRIMARY_DEMO_RESTAURANT).performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("数据来源：", substring = true)
            .performScrollTo()
            .assertIsDisplayed()
    }

    private fun shareFileNames(directory: File): Set<String> =
        directory.listFiles().orEmpty().filter(File::isFile).map(File::getName).toSet()

    private fun hasText(text: String, substring: Boolean = false): Boolean =
        composeRule.onAllNodesWithText(
            text = text,
            substring = substring,
            useUnmergedTree = true,
        ).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()

    private fun demoRecommendation() = RecommendationResult(
        provider = "DEMO",
        resultToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        dataMode = RecommendationDataMode.DEMO,
        actions = RecommendationActions(true, true, true, true),
        name = "演示·无分享目标餐厅",
        address = "虚构演示地址（不对应真实商户）",
        rank = 1,
        fitScore = null,
        sourceRating = 4.5,
        averageCostYuan = 35.0,
        distanceMeters = 420.0,
        estimatedTravelMinutes = 8.0,
        estimatedMealMinutes = 35.0,
        openStatus = OpenStatus.OPEN,
        tags = listOf("演示"),
        imageUrl = null,
        phone = null,
        location = Coordinate(39.9, 116.4, crs = CoordinateReferenceSystem.GCJ02),
        reasons = emptyList(),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "虚构演示数据，不可用于真实就餐决策",
    )

    private class ShareBoundaryContext(
        base: ChiShenMeApplication,
    ) : ContextWrapper(base) {
        var cacheDirectoryAccesses: Int = 0
            private set
        var packageNameAccesses: Int = 0
            private set
        var launchAttempts: Int = 0
            private set

        override fun getCacheDir(): File {
            cacheDirectoryAccesses += 1
            return super.getCacheDir()
        }

        override fun getPackageName(): String {
            packageNameAccesses += 1
            return super.getPackageName()
        }

        override fun startActivity(intent: Intent) {
            launchAttempts += 1
        }
    }

    private companion object {
        const val STARTUP_TIMEOUT_MS = 10_000L
        const val RECOMMENDATION_TIMEOUT_MS = 20_000L
        const val SHARE_DIRECTORY_NAME = "share_cards"
        const val MANUAL_LOCATION = "北京大学东门"
        const val PRIMARY_DEMO_RESTAURANT = "演示·校园面馆"
        const val DETAIL_EXPIRED_MARKER = "详情会话已失效"

        val RECOMMENDATION_DIAGNOSTICS = listOf(
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
    }
}
