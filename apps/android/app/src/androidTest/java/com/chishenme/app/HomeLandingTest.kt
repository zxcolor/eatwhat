package com.chishenme.app

import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.feature.home.HomeLanding
import com.chishenme.app.feature.home.HomeSurfaceTheme
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
    private val decisions = mutableListOf<MealPeriod>()
    private val locations = AtomicInteger()
    private val conditions = AtomicInteger()

    @Test
    fun mealSelectionAndFoodAction_dispatchExactlyTheVisibleMeal() = withHome {
        for (meal in MealPeriod.entries) {
            composeRule.onNodeWithTag("meal-${meal.name.lowercase()}").performClick().assertIsSelected()
            composeRule.captureUiRefinementScreenshot("food-home-${meal.name.lowercase()}.png")
            composeRule.onNodeWithTag("home-decide").assertIsDisplayed().performClick()
        }
        composeRule.runOnIdle { assertEquals(MealPeriod.entries.toList(), decisions) }
        composeRule.onNodeWithTag("home-location").performClick()
        composeRule.onNodeWithTag("home-conditions").performClick()
        assertEquals(1, locations.get())
        assertEquals(1, conditions.get())
        composeRule.onNodeWithText("手动选择").assertDoesNotExist()
        composeRule.onNodeWithText("按你的想法来").assertDoesNotExist()
        composeRule.onNodeWithText("吃什么").assertDoesNotExist()
    }

    @Test
    fun unavailableMealsAndDecision_remainDisabled() = withHome(enabled = false) {
        composeRule.onNodeWithTag("meal-breakfast").assertIsNotEnabled().performClick()
        composeRule.onNodeWithTag("meal-dinner").assertIsNotEnabled().performClick()
        composeRule.onNodeWithTag("meal-lunch").assertIsSelected()
        composeRule.onNodeWithTag("home-decide").assertIsNotEnabled().performClick()
        composeRule.runOnIdle { assertEquals(emptyList<MealPeriod>(), decisions) }
        composeRule.onNodeWithTag("home-location").performClick()
        assertEquals(1, locations.get())
    }

    @Test
    fun largeTextInDarkTheme_keepsControlsReachableAndActionReadable() = withHome(largeText = true) {
        composeRule.onNodeWithTag("meal-dinner").performScrollTo().performClick().assertIsSelected()
        composeRule.onNodeWithText("现在决定").performScrollTo().assertIsDisplayed()
        composeRule.captureUiRefinementScreenshot("food-home-dark-large-text.png")
        composeRule.onNodeWithTag("home-decide").performClick()
        composeRule.onNodeWithTag("home-location").performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("home-conditions").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(1, locations.get())
        assertEquals(1, conditions.get())
        composeRule.runOnIdle { assertEquals(listOf(MealPeriod.DINNER), decisions) }
    }

    private fun withHome(enabled: Boolean = true, largeText: Boolean = false, assertions: () -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    ChiShenMeTheme(if (largeText) ThemePreference.DARK else ThemePreference.LIGHT) {
                        val density = LocalDensity.current
                        CompositionLocalProvider(LocalDensity provides Density(density.density, if (largeText) 1.6f else 1f)) {
                            var meal by remember { mutableStateOf(MealPeriod.LUNCH) }
                            HomeSurfaceTheme {
                                HomeLanding(
                                    meal = meal,
                                    availableMeals = if (enabled) MealPeriod.entries.toSet() else setOf(MealPeriod.LUNCH),
                                    locationLabel = if (largeText) "用于验证省略展示与触控的长地点名称" else null,
                                    locationDescription = "合成界面测试，无真实位置",
                                    conditionsDescription = "预算 25 元，可用 45 分钟",
                                    decisionEnabled = enabled,
                                    showNotice = false,
                                    onMeal = { meal = it },
                                    onLocation = { locations.incrementAndGet() },
                                    onConditions = { conditions.incrementAndGet() },
                                    onDecide = { decisions.add(meal) },
                                )
                            }
                        }
                    }
                }
            }
            assertions()
        }
    }
}
