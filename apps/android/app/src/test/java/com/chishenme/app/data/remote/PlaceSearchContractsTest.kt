package com.chishenme.app.data.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaceSearchContractsTest {
    @Test
    fun `one character Chinese food keywords are accepted`() {
        assertTrue(PlaceSearchKeywordValidator.validate("面") is PlaceSearchKeywordValidation.Valid)
        assertTrue(PlaceSearchKeywordValidator.validate(" 粥 ") is PlaceSearchKeywordValidation.Valid)
    }

    @Test
    fun `sensitive or delimiter shaped keywords are rejected`() {
        listOf(
            "39.9928,116.3109",
            "面馆 13800138000",
            "test@example.com",
            "面|粥",
            "面｜粥",
            "面\n馆",
        ).forEach { value ->
            assertTrue(
                value,
                PlaceSearchKeywordValidator.validate(value) is PlaceSearchKeywordValidation.Invalid,
            )
        }
    }

    @Test
    fun `request has explicit CRS and no accuracy or provider field`() {
        val json = Json { encodeDefaults = true }.encodeToString(request())

        assertTrue(json.contains("\"crs\":\"WGS84\""))
        assertFalse(json.contains("accuracyMeters"))
        assertFalse(json.contains("provider"))
    }

    @Test
    fun `response permits rank gaps unknown safe mode and explicit demo actions`() {
        val response = response(
            results = listOf(
                result(rank = 2, token = "A".repeat(43), dataMode = "FUTURE_SAFE"),
                result(rank = 7, token = "B".repeat(43), dataMode = "LIVE"),
                result(rank = 9, token = "C".repeat(43), dataMode = "DEMO"),
            ),
        )

        assertTrue(PlaceSearchResponseValidator.isValid(response, request()))
    }

    @Test
    fun `response rejects direct call even when another action is allowed`() {
        val withCall = result().copy(
            actions = RecommendationActions(
                navigate = true,
                call = true,
                copyAddress = true,
                share = true,
            ),
        )

        assertFalse(PlaceSearchResponseValidator.isValid(response(listOf(withCall)), request()))
    }

    @Test
    fun `response rejects duplicate ranks and control characters`() {
        assertFalse(
            PlaceSearchResponseValidator.isValid(
                response(
                    listOf(
                        result(rank = 2, token = "A".repeat(43)),
                        result(rank = 2, token = "B".repeat(43)),
                    ),
                ),
                request(),
            ),
        )
        assertFalse(
            PlaceSearchResponseValidator.isValid(
                response(listOf(result().copy(sourceLabel = "危险\n来源"))),
                request(),
            ),
        )
    }

    @Test
    fun `unknown prices and hours are retained but known violations are rejected`() {
        assertTrue(
            PlaceSearchResponseValidator.isValid(
                response(listOf(result(averageCostYuan = null, openStatus = OpenStatus.UNKNOWN))),
                request(openNow = true, maxAverageCostYuan = 25),
            ),
        )
        assertFalse(
            PlaceSearchResponseValidator.isValid(
                response(listOf(result(averageCostYuan = 40.0))),
                request(maxAverageCostYuan = 25),
            ),
        )
        assertFalse(
            PlaceSearchResponseValidator.isValid(
                response(listOf(result(openStatus = OpenStatus.CLOSED))),
                request(openNow = true),
            ),
        )
    }

    @Test
    fun `outside pilot cannot carry restaurant results`() {
        assertFalse(
            PlaceSearchResponseValidator.isValid(
                response(
                    results = listOf(result()),
                    coverage = Coverage.OUTSIDE_PILOT,
                    notice = "当前位置不在试点区",
                ),
                request(),
            ),
        )
    }

    private fun request(
        openNow: Boolean = false,
        maxAverageCostYuan: Int? = null,
    ) = PlaceSearchRequest(
        location = PlaceSearchCoordinate(39.9928, 116.3109, CoordinateReferenceSystem.WGS84),
        mealPeriod = MealPeriod.LUNCH,
        keyword = "面",
        radiusMeters = 1_500,
        maxAverageCostYuan = maxAverageCostYuan,
        openNow = openNow,
        limit = 10,
    )

    private fun response(
        results: List<PlaceSearchResult>,
        coverage: Coverage = Coverage.BEIJING_FOURTH_RING,
        notice: String? = null,
    ) = PlaceSearchResponse(
        requestId = "11111111-1111-4111-8111-111111111111",
        coverage = coverage,
        results = results,
        notice = notice,
    )

    private fun result(
        rank: Int = 1,
        token: String = "A".repeat(43),
        dataMode: String = "LIVE",
        averageCostYuan: Double? = 20.0,
        openStatus: OpenStatus = OpenStatus.OPEN,
    ) = PlaceSearchResult(
        resultToken = token,
        rank = rank,
        name = "学院路面馆",
        address = "海淀区学院路 25 号",
        location = PlaceSearchCoordinate(39.993, 116.311, CoordinateReferenceSystem.WGS84),
        distanceMeters = 300,
        sourceLabel = "授权餐厅数据",
        sourceRating = 4.5,
        averageCostYuan = averageCostYuan,
        openStatus = openStatus,
        tags = listOf("面食"),
        dataMode = dataMode,
        actions = RecommendationActions(true, false, true, false),
    )
}
