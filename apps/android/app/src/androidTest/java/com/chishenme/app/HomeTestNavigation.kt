package com.chishenme.app

import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick

/** Follow the visible sheet entries instead of relying on the retired home form. */
internal fun ComposeTestRule.openHomeConditions() {
    if (onAllNodesWithText("完成").fetchSemanticsNodes().isEmpty()) {
        if (onAllNodesWithText("本次推荐条件").fetchSemanticsNodes().isEmpty()) {
            onNodeWithTag("dock-personal").assertIsDisplayed().performClick()
        }
        onNodeWithTag("personal-conditions").assertIsDisplayed().performClick()
    }
}

internal fun ComposeTestRule.closeHomePanel() {
    if (onAllNodesWithText("完成").fetchSemanticsNodes().isNotEmpty()) {
        onNodeWithText("完成").assertIsDisplayed().performClick()
    }
}

internal fun ComposeTestRule.homeSettingsAction(): SemanticsNodeInteraction {
    closeHomePanel()
    if (onAllNodesWithText("本次推荐条件").fetchSemanticsNodes().isEmpty()) {
        onNodeWithTag("dock-personal").assertIsDisplayed().performClick()
    }
    return onNodeWithTag("personal-settings")
}

internal fun ComposeTestRule.homeManualLocationAction(): SemanticsNodeInteraction {
    if (onAllNodesWithText("手动选择").fetchSemanticsNodes().isEmpty()) {
        onNodeWithTag("home-location").assertIsDisplayed().performClick()
    }
    return onNodeWithText("手动选择")
}
