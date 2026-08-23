package com.chishenme.app.data.remote

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureConfigSupportFeedbackCapabilityTest {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = false
    }

    @Test
    fun `older feature config fails support feedback closed when field is missing`() {
        val config = json.decodeFromString<FeatureConfig>(featureConfigJson(null))

        assertFalse(config.supportFeedbackEnabled)
    }

    @Test
    fun `feature config preserves explicitly enabled guest feedback`() {
        val config = json.decodeFromString<FeatureConfig>(featureConfigJson(true))

        assertTrue(config.supportFeedbackEnabled)
        assertFalse(config.accountsEnabled)
    }

    private fun featureConfigJson(supportFeedbackEnabled: Boolean?): String {
        val capability = supportFeedbackEnabled
            ?.let { ",\"supportFeedbackEnabled\":$it" }
            .orEmpty()
        return """
            {
              "coverageName": "北京四环试点区",
              "dataRightsMode": "LIVE_DISPLAY_ONLY",
              "aiEnabled": false,
              "accountsEnabled": false,
              "favoritesEnabled": false$capability,
              "minimumSupportedVersion": "0.1.0",
              "ruleVersion": "rule-v1",
              "promptVersion": "prompt-v1",
              "modelVersion": "rule-fallback-v1"
            }
        """.trimIndent()
    }
}
