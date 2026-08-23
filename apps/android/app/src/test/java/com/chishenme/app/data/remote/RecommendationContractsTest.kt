package com.chishenme.app.data.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalSerializationApi::class)
class RecommendationContractsTest {
    private val json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }

    @Test
    fun `request uses shared contract field names and enum values`() {
        val request = RecommendationContext(
            location = Coordinate(
                39.9928,
                116.3109,
                crs = CoordinateReferenceSystem.WGS84,
            ),
            locationLabel = "北京大学东门",
            mealPeriod = MealPeriod.LUNCH,
            radiusMeters = 1_500,
        )
        val parsed = json.parseToJsonElement(json.encodeToString(request)).jsonObject

        assertEquals("LUNCH", parsed.getValue("mealPeriod").toString().trim('"'))
        assertEquals("QUICK", parsed.getValue("decisionMode").toString().trim('"'))
        assertTrue("budgetMaxYuan" !in parsed)
        assertTrue("location" in parsed)
        assertEquals(
            "WGS84",
            parsed.getValue("location").jsonObject.getValue("crs").toString().trim('"'),
        )
        assertFalse(parsed.keys.any { it.contains("phone", ignoreCase = true) })
    }

    @Test
    fun `coordinate wire format requires and preserves explicit crs`() {
        assertThrows(SerializationException::class.java) {
            json.decodeFromString<Coordinate>("""{"latitude":39.9,"longitude":116.4}""")
        }
        val gcj02 = json.decodeFromString<Coordinate>(
            """{"latitude":39.901,"longitude":116.406,"crs":"GCJ02"}""",
        )

        assertEquals(CoordinateReferenceSystem.GCJ02, gcj02.crs)
    }

    @Test
    fun `analytics event carries only opaque result token and event metadata`() {
        val event = RecommendationEvent(
            requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
            resultToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            type = RecommendationEventType.DETAIL,
            occurredAt = "2026-08-20T04:00:00Z",
        )
        val parsed = json.parseToJsonElement(json.encodeToString(event)).jsonObject

        assertEquals(setOf("requestId", "resultToken", "type", "occurredAt"), parsed.keys)
        assertFalse("provider" in parsed)
        assertFalse("providerPlaceId" in parsed)
        assertFalse("location" in parsed)
        assertFalse("latitude" in parsed)
    }

    @Test
    fun `parses nullable response facts without inventing values`() {
        val payload = """
            {
              "requestId":"2af305ae-82a1-4f87-86b7-1c97c4a8683f",
              "generatedAt":"2026-08-20T04:00:00Z",
              "coverage":"BEIJING_FOURTH_RING",
              "dataRightsMode":"LIVE_DISPLAY_ONLY",
              "ruleVersion":"v1",
              "promptVersion":"v1",
              "modelVersion":"rule-fallback",
              "aiFallbackUsed":true,
              "results":[{
                "provider":"LOCAL_PARTNER_7","resultToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dataMode":"LIVE",
                "actions":{"navigate":true,"call":false,"copyAddress":true,"share":false},
                "name":"演示面馆","address":"北京市海淀区",
                "rank":1,"fitScore":null,"sourceRating":null,"averageCostYuan":null,"distanceMeters":520,
                "estimatedTravelMinutes":8,"estimatedMealMinutes":22,"openStatus":"UNKNOWN","tags":["面食"],
                "imageUrl":null,"phone":null,"location":{"latitude":39.99,"longitude":116.31,"crs":"GCJ02"},
                "reasons":[{"code":"TIME_FIT","text":"时间可行"}],"warnings":["营业时间待确认"],
                "confidence":"LOW","aiAssisted":false,"sourceAttribution":"演示数据"
              }],
              "notice":null
            }
        """.trimIndent()
        val response = json.decodeFromString<RecommendationResponse>(payload)
        val requestContext = RecommendationContext(
            location = Coordinate(39.9928, 116.3109, crs = CoordinateReferenceSystem.WGS84),
            mealPeriod = MealPeriod.LUNCH,
            radiusMeters = 1_500,
        )

        assertEquals(DataRightsMode.LIVE_DISPLAY_ONLY, response.dataRightsMode)
        assertEquals("LOCAL_PARTNER_7", response.results.first().provider)
        assertEquals(RecommendationDataMode.LIVE, response.results.first().dataMode)
        assertTrue(response.results.first().actions.navigate)
        assertFalse(response.results.first().actions.call)
        assertNull(response.results.first().fitScore)
        assertNull(response.results.first().averageCostYuan)
        assertEquals(Confidence.LOW, response.results.first().confidence)
        assertTrue(RecommendationResponseValidator.isValid(response, requestContext))

        val duplicate = response.copy(results = listOf(response.results.first(), response.results.first()))
        assertFalse(RecommendationResponseValidator.isValid(duplicate, requestContext))

        val insecureImage = response.copy(
            results = listOf(response.results.first().copy(imageUrl = "http://example.com/image.jpg")),
        )
        assertFalse(RecommendationResponseValidator.isValid(insecureImage, requestContext))

        val impossibleAccuracy = response.copy(
            results = listOf(
                response.results.first().copy(
                    location = response.results.first().location.copy(accuracyMeters = 10_001.0),
                ),
            ),
        )
        assertFalse(RecommendationResponseValidator.isValid(impossibleAccuracy, requestContext))
    }

    @Test
    fun `recommendation response requires explicit data mode and action capabilities`() {
        val missingCapabilities = """
            {
              "provider":"LOCAL_PARTNER_7","resultToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dataMode":"LIVE",
              "actions":{"navigate":true,"call":true,"copyAddress":true},"name":"测试餐厅",
              "address":"北京市测试路 1 号","rank":1,"fitScore":null,"sourceRating":null,
              "averageCostYuan":null,"distanceMeters":100,"estimatedTravelMinutes":2,
              "estimatedMealMinutes":20,"openStatus":"UNKNOWN","tags":[],"imageUrl":null,
              "phone":null,"location":{"latitude":39.99,"longitude":116.31,"crs":"WGS84"},
              "reasons":[{"code":"DISTANCE_FIT","text":"距离合适"}],"warnings":[],
              "confidence":"LOW","aiAssisted":false,"sourceAttribution":"合作数据源"
            }
        """.trimIndent()

        assertThrows(SerializationException::class.java) {
            json.decodeFromString<RecommendationResult>(missingCapabilities)
        }

        val missingDataMode = missingCapabilities
            .replace(",\"dataMode\":\"LIVE\"", "")
            .replace(",\"copyAddress\":true}", ",\"copyAddress\":true,\"share\":true}")
        assertThrows(SerializationException::class.java) {
            json.decodeFromString<RecommendationResult>(missingDataMode)
        }

        val missingResultToken = missingCapabilities
            .replace(",\"resultToken\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"", "")
            .replace(",\"copyAddress\":true}", ",\"copyAddress\":true,\"share\":true}")
        assertThrows(SerializationException::class.java) {
            json.decodeFromString<RecommendationResult>(missingResultToken)
        }
    }
}
