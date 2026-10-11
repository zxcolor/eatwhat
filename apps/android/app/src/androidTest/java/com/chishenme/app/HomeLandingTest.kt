package com.chishenme.app

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.chishenme.app.data.local.ThemePreference
import com.chishenme.app.feature.account.PersonalScreen
import com.chishenme.app.feature.home.HomeLanding
import com.chishenme.app.feature.home.HomeSurfaceTheme
import com.chishenme.app.ui.AppDock
import com.chishenme.app.ui.AppTab
import com.chishenme.app.ui.theme.ChiShenMeTheme
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Isolated native UI checks: no permissions, provider requests, or real user data. */
@RunWith(AndroidJUnit4::class)
class HomeLandingTest {
    @get:Rule val composeRule = createEmptyComposeRule()
    private val decisions = AtomicInteger()
    private val locations = AtomicInteger()
    private val conditions = AtomicInteger()
    private val settings = AtomicInteger()
    private var tab by mutableStateOf(AppTab.HOME)

    @Test
    fun homepageAndPersonal_dispatchActionsWithoutRetiredControls() = withHome {
        composeRule.onNodeWithText("今天中午吃什么").assertIsDisplayed()
        composeRule.onNodeWithText("What to eat？").assertIsDisplayed()
        composeRule.onNodeWithText("早餐").assertDoesNotExist()
        composeRule.onNodeWithText("午餐").assertDoesNotExist()
        composeRule.onNodeWithText("晚餐").assertDoesNotExist()
        composeRule.onNodeWithText("AI 推荐").assertDoesNotExist()
        composeRule.onNodeWithText("投票").assertDoesNotExist()
        composeRule.onNodeWithTag("home-conditions").assertDoesNotExist()
        composeRule.onNodeWithText("设置").assertDoesNotExist()
        composeRule.onNodeWithTag("home-decide").assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("home-location").performClick()
        assertEquals(1, decisions.get())
        assertEquals(1, locations.get())
        composeRule.captureUiRefinementScreenshot("decision-home-light.png")

        composeRule.onNodeWithTag("dock-history").performClick().assertIsSelected()
        composeRule.runOnIdle { assertEquals(AppTab.HISTORY, tab) }
        composeRule.onNodeWithTag("dock-personal").performClick().assertIsSelected()
        composeRule.onNodeWithTag("personal-settings").assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("personal-conditions").assertIsDisplayed().performClick()
        assertEquals(1, settings.get())
        assertEquals(1, conditions.get())
        composeRule.captureUiRefinementScreenshot("decision-personal-light.png")
        composeRule.onNodeWithTag("dock-home").performClick().assertIsSelected()
    }

    @Test
    fun unavailableDecision_remainsDisabledWhileNavigationIsUsable() = withHome(enabled = false) {
        composeRule.onNodeWithTag("home-decide").assertIsNotEnabled().performClick()
        assertEquals(0, decisions.get())
        composeRule.onNodeWithTag("home-location").performClick()
        assertEquals(1, locations.get())
        composeRule.onNodeWithTag("dock-personal").performClick()
        composeRule.onNodeWithTag("personal-settings").assertIsDisplayed().performClick()
        assertEquals(1, settings.get())
    }

    @Test
    fun largeTextInDarkTheme_keepsControlsReachableAndActionReadable() = withHome(largeText = true) {
        composeRule.onNodeWithText("帮我选").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("home-decide").performClick()
        composeRule.onNodeWithTag("home-location").performScrollTo().assertIsDisplayed().performClick()
        composeRule.captureUiRefinementScreenshot("decision-home-dark-large-text.png")
        assertEquals(1, decisions.get())
        assertEquals(1, locations.get())
        composeRule.onNodeWithTag("dock-personal").assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("personal-conditions").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(1, conditions.get())
    }

    private fun withHome(enabled: Boolean = true, largeText: Boolean = false, assertions: () -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    ChiShenMeTheme(if (largeText) ThemePreference.DARK else ThemePreference.LIGHT) {
                        val density = LocalDensity.current
                        CompositionLocalProvider(LocalDensity provides Density(density.density, if (largeText) 1.6f else 1f)) {
                            HomeSurfaceTheme {
                                if (tab == AppTab.PERSONAL) {
                                    PersonalScreen(
                                        onSelectTab = { tab = it },
                                        onOpenAccount = {},
                                        onOpenSettings = { settings.incrementAndGet() },
                                        onOpenConditions = { conditions.incrementAndGet() },
                                    )
                                } else {
                                    Scaffold(bottomBar = { AppDock(tab) { tab = it } }) { padding ->
                                        HomeLanding(
                                            modifier = Modifier.padding(padding),
                                            locationLabel = if (largeText) "用于验证省略展示与触控的长地点名称" else null,
                                            locationDescription = "合成界面测试，无真实位置",
                                            decisionEnabled = enabled,
                                            showNotice = false,
                                            onLocation = { locations.incrementAndGet() },
                                            onDecide = { decisions.incrementAndGet() },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            assertions()
        }
    }
}
