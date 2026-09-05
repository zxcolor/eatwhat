package com.chishenme.app.data.remote

import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FeatureConfigRecommendationDefaultsTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `older services omit operational defaults without changing existing fields`() {
        val config = json.decodeFromString<FeatureConfig>(configJson())
        assertNull(config.recommendationDefaults)
        assertEquals("0.1.0", config.minimumSupportedVersion)
    }

    @Test
    fun `current defaults retain exact integer distances and ignore unrelated diagnostics`() {
        val config = json.decodeFromString<FeatureConfig>(
            configJson(
                """, "recommendationDefaults": {
                  "areaCode": "NATIONWIDE", "defaultRadiusMeters": 750, "maximumRadiusMeters": 1250
                }, "operationalConfig": {"source": "DATABASE"}""",
            ),
        )
        assertEquals(PublicRecommendationDefaults("NATIONWIDE", 750, 1250), config.recommendationDefaults)
        assertTrue(requireNotNull(config.recommendationDefaults).isValid())
    }

    @Test
    fun `partial or non integer operational limits cannot become trusted defaults`() {
        val malformedObjects = listOf(
            """{"areaCode":"NATIONWIDE","defaultRadiusMeters":750}""",
            """{"areaCode":"NATIONWIDE","defaultRadiusMeters":750.5,"maximumRadiusMeters":1000}""",
            """{"areaCode":"NATIONWIDE","defaultRadiusMeters":750,"maximumRadiusMeters":null}""",
        )
        malformedObjects.forEach { value ->
            try {
                json.decodeFromString<FeatureConfig>(configJson(",\"recommendationDefaults\":$value"))
                fail("Malformed radius configuration was accepted")
            } catch (_: SerializationException) {
                // Incomplete data never acquires a usable radius policy.
            }
        }
    }

    private fun configJson(extra: String = "") = """
        {
          "coverageName":"全国服务", "dataRightsMode":"LIVE_DISPLAY_ONLY",
          "aiEnabled":false, "accountsEnabled":false, "favoritesEnabled":false,
          "minimumSupportedVersion":"0.1.0", "ruleVersion":"rule-v1",
          "promptVersion":"prompt-v1", "modelVersion":"rule-fallback-v1"$extra
        }
    """.trimIndent()
}
