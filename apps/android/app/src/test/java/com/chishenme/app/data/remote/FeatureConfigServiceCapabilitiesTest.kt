package com.chishenme.app.data.remote

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureConfigServiceCapabilitiesTest {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = false
    }

    @Test
    fun `older feature config closes every core remote service`() {
        val config = json.decodeFromString<FeatureConfig>(featureConfigJson(null))

        val capabilities = config.effectiveServiceCapabilities()
        assertFalse(capabilities.recommendationsEnabled)
        assertFalse(capabilities.locationSearchEnabled)
        assertFalse(capabilities.placeSearchEnabled)
    }

    @Test
    fun `missing fields inside capability object also fail closed`() {
        val config = json.decodeFromString<FeatureConfig>(featureConfigJson("{}"))

        val capabilities = config.effectiveServiceCapabilities()
        assertFalse(capabilities.recommendationsEnabled)
        assertFalse(capabilities.locationSearchEnabled)
        assertFalse(capabilities.placeSearchEnabled)
    }

    @Test
    fun `legacy group capability is ignored while individual capabilities remain available`() {
        val config = json.decodeFromString<FeatureConfig>(
            featureConfigJson(
                """{
                  "recommendationsEnabled": true,
                  "locationSearchEnabled": false,
                  "placeSearchEnabled": true,
                  "groupRecommendationsEnabled": true
                }""".trimIndent(),
            ),
        )

        val capabilities = config.effectiveServiceCapabilities()
        assertTrue(capabilities.recommendationsEnabled)
        assertFalse(capabilities.locationSearchEnabled)
        assertTrue(capabilities.placeSearchEnabled)
    }

    @Test
    fun `older service object remains compatible without retired fields`() {
        val config = json.decodeFromString<FeatureConfig>(
            featureConfigJson(
                """{
                  "recommendationsEnabled": true,
                  "locationSearchEnabled": true,
                  "placeSearchEnabled": true
                }""".trimIndent(),
            ),
        )

        val capabilities = config.effectiveServiceCapabilities()
        assertTrue(capabilities.recommendationsEnabled)
        assertTrue(capabilities.locationSearchEnabled)
        assertTrue(capabilities.placeSearchEnabled)
    }

    private fun featureConfigJson(serviceCapabilities: String?): String {
        val capability = serviceCapabilities
            ?.let { ",\"serviceCapabilities\":$it" }
            .orEmpty()
        return """
            {
              "coverageName": "全国服务",
              "dataRightsMode": "LIVE_DISPLAY_ONLY",
              "aiEnabled": false,
              "accountsEnabled": false,
              "favoritesEnabled": false,
              "minimumSupportedVersion": "0.1.0",
              "ruleVersion": "rule-v1",
              "promptVersion": "prompt-v1",
              "modelVersion": "rule-fallback-v1"$capability
            }
        """.trimIndent()
    }
}
