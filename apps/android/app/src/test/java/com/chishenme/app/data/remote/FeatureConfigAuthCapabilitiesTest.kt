package com.chishenme.app.data.remote

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureConfigAuthCapabilitiesTest {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = false
    }

    @Test
    fun `feature config preserves an explicitly enabled data export capability`() {
        val config = json.decodeFromString<FeatureConfig>(featureConfigJson(dataExportField = "true"))

        assertTrue(requireNotNull(config.authCapabilities).dataExportEnabled)
    }

    @Test
    fun `older auth capability payload fails closed when data export field is missing`() {
        val config = json.decodeFromString<FeatureConfig>(featureConfigJson(dataExportField = null))

        assertFalse(requireNotNull(config.authCapabilities).dataExportEnabled)
    }

    private fun featureConfigJson(dataExportField: String?): String {
        val optionalField = dataExportField?.let { ",\"dataExportEnabled\":$it" }.orEmpty()
        return """
            {
              "coverageName": "北京四环试点区",
              "dataRightsMode": "LIVE_DISPLAY_ONLY",
              "aiEnabled": false,
              "accountsEnabled": true,
              "favoritesEnabled": false,
              "minimumSupportedVersion": "0.1.0",
              "ruleVersion": "rule-v1",
              "promptVersion": "prompt-v1",
              "modelVersion": "rule-fallback-v1",
              "authCapabilities": {
                "accountsEnabled": true,
                "registrationEnabled": false,
                "phoneEnabled": true,
                "wechatEnabled": true,
                "emailEnabled": true,
                "qqEnabled": false$optionalField
              }
            }
        """.trimIndent()
    }
}
