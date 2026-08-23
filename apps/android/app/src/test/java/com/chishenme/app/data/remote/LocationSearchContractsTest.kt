package com.chishenme.app.data.remote

import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationSearchContractsTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `query validation requires two characters and normalizes whitespace`() {
        assertTrue(LocationSearchQueryValidator.validate(" 北 ") is LocationSearchQueryValidation.Invalid)

        val valid = LocationSearchQueryValidator.validate("  北京   大学  ")
        assertEquals("北京 大学", (valid as LocationSearchQueryValidation.Valid).normalizedQuery)
    }

    @Test
    fun `unknown but well formed provider code remains forward compatible`() {
        val response = json.decodeFromString<LocationSearchResponse>(
            """
            {
              "requestId":"2af305ae-82a1-4f87-86b7-1c97c4a8683f",
              "dataSource":"LOCAL_PARTNER_7",
              "dataMode":"LIVE",
              "results":[{
                "name":"新供应商地点",
                "address":null,
                "location":{"latitude":39.98,"longitude":116.31,"crs":"GCJ02"},
                "sourceLabel":"合作数据源",
                "providerRank":1
              }],
              "notice":null
            }
            """.trimIndent(),
        )

        assertEquals("LOCAL_PARTNER_7", response.dataSource)
        assertEquals(LocationSearchDataMode.LIVE, response.dataMode)
        assertTrue(LocationSearchResponseValidator.isValid(response))
    }

    @Test
    fun `invalid or overlong provider codes fail closed`() {
        val base = validResponse(dataSource = "AMAP")

        assertFalse(LocationSearchResponseValidator.isValid(base.copy(dataSource = "amap")))
        assertFalse(LocationSearchResponseValidator.isValid(base.copy(dataSource = "A".repeat(33))))
        assertFalse(LocationSearchResponseValidator.isValid(base.copy(dataSource = "AMAP-DIRECT")))
    }

    @Test
    fun `location search coordinate requires explicit crs`() {
        assertThrows(SerializationException::class.java) {
            json.decodeFromString<LocationSearchResponse>(
                """
                {
                  "requestId":"2af305ae-82a1-4f87-86b7-1c97c4a8683f",
                  "dataSource":"AMAP",
                  "dataMode":"LIVE",
                  "results":[{
                    "name":"缺少坐标系",
                    "location":{"latitude":39.98,"longitude":116.31},
                    "sourceLabel":"地点数据源",
                    "providerRank":1
                  }]
                }
                """.trimIndent(),
            )
        }
    }

    private fun validResponse(dataSource: String) = LocationSearchResponse(
        requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
        dataSource = dataSource,
        dataMode = LocationSearchDataMode.LIVE,
        results = listOf(
            LocationSearchPlace(
                name = "测试地点",
                address = "北京市测试路 1 号",
                location = LocationSearchCoordinate(39.98, 116.31, CoordinateReferenceSystem.WGS84),
                sourceLabel = "地点数据源",
                providerRank = 1,
            ),
        ),
    )

    @Test
    fun `query validation rejects sensitive and protocol shaped input locally`() {
        val invalidQueries = listOf(
            "北京\n大学" to "控制字符",
            "北京|大学" to "管道",
            "39.9928,116.3109" to "经纬度",
            "位置 116.3109,39.9928 附近" to "经纬度",
            "北京大学13800138000" to "手机号",
            "联系 +86 138-0013-8000" to "手机号",
            "test@example.com" to "邮箱",
        )

        invalidQueries.forEach { (query, expectedMessagePart) ->
            val result = LocationSearchQueryValidator.validate(query)
            assertTrue("Expected invalid query: $query", result is LocationSearchQueryValidation.Invalid)
            assertTrue(
                (result as LocationSearchQueryValidation.Invalid).message.contains(expectedMessagePart),
            )
        }
    }

    @Test
    fun `response validation enforces canonical UUID and 200 character address`() {
        val base = validResponse(dataSource = "AMAP")

        assertFalse(LocationSearchResponseValidator.isValid(base.copy(requestId = "request-1")))
        assertFalse(LocationSearchResponseValidator.isValid(base.copy(requestId = "1-1-1-1-1")))
        assertFalse(
            LocationSearchResponseValidator.isValid(
                base.copy(results = listOf(base.results.single().copy(address = "地".repeat(201)))),
            ),
        )
        assertTrue(
            LocationSearchResponseValidator.isValid(
                base.copy(results = listOf(base.results.single().copy(address = "地".repeat(200)))),
            ),
        )
    }
}
