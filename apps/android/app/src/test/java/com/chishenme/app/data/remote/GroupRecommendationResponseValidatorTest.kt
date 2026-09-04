package com.chishenme.app.data.remote

import com.chishenme.app.di.strictGroupRecommendationJson
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GroupRecommendationResponseValidatorTest {
    private val request = GroupRecommendationRequest(
        location = Coordinate(39.9, 116.4, 50.0, CoordinateReferenceSystem.WGS84),
        travelMode = TravelMode.WALK,
        members = listOf(
            member(budget = null, minutes = 60, radius = 1_500, preferred = listOf("面食", "米饭")),
            member(
                budget = 40,
                minutes = 45,
                radius = 1_000,
                preferred = listOf("面食", "米饭"),
                excluded = listOf("火锅"),
            ),
        ),
    )
    private val aggregation = GroupConstraintAggregation(
        version = "group-constraints-v1",
        memberCount = 2,
        effectiveBudgetMaxYuan = 40,
        effectiveAvailableMinutes = 45,
        effectiveRadiusMeters = 1_000,
        preferredCuisines = listOf("面食", "米饭"),
        excludedCuisines = listOf("火锅"),
    )

    @Test
    fun `accepts valid live display-only response without score`() {
        assertTrue(
            validate(
                response(),
                request,
                aggregation,
            ),
        )
    }

    @Test
    fun `rejects every server aggregation mismatch and wrong version`() {
        val mismatches = listOf(
            aggregation.copy(version = "group-constraints-v2"),
            aggregation.copy(memberCount = 3),
            aggregation.copy(effectiveBudgetMaxYuan = null),
            aggregation.copy(effectiveAvailableMinutes = 46),
            aggregation.copy(effectiveRadiusMeters = 999),
            aggregation.copy(preferredCuisines = listOf("面食")),
            aggregation.copy(excludedCuisines = emptyList()),
        )
        mismatches.forEach { mismatch ->
            assertFalse(
                validate(
                    response().copy(aggregation = mismatch),
                    request,
                    aggregation,
                ),
            )
        }
    }

    @Test
    fun `live mode rejects score while licensed mode accepts bounded score`() {
        val scored = response().copy(results = listOf(result().copy(fitScore = 88.0)))
        assertFalse(validate(scored, request, aggregation))
        assertTrue(
            validate(
                scored.copy(dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT),
                request,
                aggregation,
                DataRightsMode.LICENSED_ENRICHMENT,
            ),
        )
        assertFalse(
            validate(
                scored.copy(
                    dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT,
                    results = listOf(result().copy(fitScore = 101.0)),
                ),
                request,
                aggregation,
                DataRightsMode.LICENSED_ENRICHMENT,
            ),
        )
    }

    @Test
    fun `response authority must exactly match trusted rights mode and rule version`() {
        assertFalse(
            validate(
                response().copy(
                    dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT,
                    results = listOf(result().copy(fitScore = 88.0)),
                ),
                request,
                aggregation,
            ),
        )
        assertFalse(
            validate(
                response().copy(ruleVersion = "unexpected-rule-v3"),
                request,
                aggregation,
            ),
        )
        assertTrue(
            validate(
                response().copy(
                    dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT,
                    results = listOf(result().copy(fitScore = 88.0)),
                ),
                request,
                aggregation,
                expectedMode = DataRightsMode.LICENSED_ENRICHMENT,
                expectedRuleVersion = "rule-v2",
            ),
        )
    }

    @Test
    fun `rejects reordered ranks and more than three display results`() {
        assertFalse(
            validate(
                response().copy(results = listOf(result().copy(rank = 2))),
                request,
                aggregation,
            ),
        )
        assertFalse(
            validate(
                response().copy(results = List(4) { index -> result().copy(rank = index + 1) }),
                request,
                aggregation,
            ),
        )
    }

    @Test
    fun `rejects results that violate common hard constraints`() {
        val invalidResults = listOf(
            result().copy(openStatus = OpenStatus.CLOSED),
            result().copy(distanceMeters = 1_001.0),
            result().copy(averageCostYuan = 41.0),
            result().copy(tags = listOf("重庆火锅")),
        )
        invalidResults.forEach { invalid ->
            assertFalse(
                validate(
                    response().copy(results = listOf(invalid)),
                    request,
                    aggregation,
                ),
            )
        }
    }

    @Test
    fun `strict group response codec rejects forbidden token action and identity fields`() {
        val json = strictGroupRecommendationJson(
            Json {
                explicitNulls = false
                encodeDefaults = true
            },
        )
        val encoded = json.encodeToString(response())
        for (forbiddenField in listOf("resultToken", "actions", "location", "phone", "imageUrl", "aiAssisted")) {
            val forbiddenValue = when (forbiddenField) {
                "actions" -> "{}"
                "location" -> "{}"
                "aiAssisted" -> "false"
                else -> "\"forbidden\""
            }
            val injected = encoded.replace(
                "\"provider\":",
                "\"$forbiddenField\":$forbiddenValue,\"provider\":",
            )
            assertThrows(SerializationException::class.java) {
                json.decodeFromString<GroupRecommendationResponse>(injected)
            }
        }
    }

    @Test
    fun `strict group response codec rejects missing required nullable fields`() {
        val json = strictGroupRecommendationJson(
            Json {
                explicitNulls = false
                encodeDefaults = true
            },
        )
        val root = json.parseToJsonElement(json.encodeToString(response())).jsonObject
        val aggregation = root.getValue("aggregation").jsonObject
        val results = root.getValue("results").jsonArray

        fun withoutResultField(field: String): JsonObject {
            val first = JsonObject(results.first().jsonObject - field)
            return JsonObject(
                root + ("results" to JsonArray(listOf(first) + results.drop(1))),
            )
        }

        val missingVariants = listOf(
            JsonObject(root - "notice"),
            JsonObject(
                root + (
                    "aggregation" to
                        JsonObject(aggregation - "effectiveBudgetMaxYuan")
                    ),
            ),
            withoutResultField("fitScore"),
            withoutResultField("sourceRating"),
            withoutResultField("averageCostYuan"),
        )

        missingVariants.forEach { missing ->
            assertThrows(SerializationException::class.java) {
                json.decodeFromJsonElement<GroupRecommendationResponse>(missing)
            }
        }
    }

    @Test
    fun `strict group response codec accepts explicit nulls and preserves them on the wire`() {
        val json = strictGroupRecommendationJson(
            Json {
                explicitNulls = false
                encodeDefaults = true
            },
        )
        val expected = response().copy(
            aggregation = aggregation.copy(effectiveBudgetMaxYuan = null),
            results = listOf(
                result().copy(fitScore = null, sourceRating = null, averageCostYuan = null),
            ),
            notice = null,
        )
        val encoded = json.encodeToString(expected)
        val root = json.parseToJsonElement(encoded).jsonObject
        val encodedResult = root.getValue("results").jsonArray.single().jsonObject

        assertEquals(expected, json.decodeFromString<GroupRecommendationResponse>(encoded))
        assertEquals(JsonNull, root.getValue("notice"))
        assertEquals(
            JsonNull,
            root.getValue("aggregation").jsonObject.getValue("effectiveBudgetMaxYuan"),
        )
        for (field in listOf("fitScore", "sourceRating", "averageCostYuan")) {
            assertEquals(JsonNull, encodedResult.getValue(field))
        }
    }

    @Test
    fun `strict group response codec checks nullable keys in every candidate`() {
        val json = strictGroupRecommendationJson(Json { explicitNulls = false })
        val expected = response().copy(
            results = List(3) { index -> result().copy(rank = index + 1) },
        )
        val root = json.parseToJsonElement(json.encodeToString(expected)).jsonObject
        val results = root.getValue("results").jsonArray
        assertEquals(expected, json.decodeFromJsonElement<GroupRecommendationResponse>(root))

        for (index in 1..2) {
            for (field in listOf("fitScore", "sourceRating", "averageCostYuan")) {
                val missingResults = results.mapIndexed { candidateIndex, candidate ->
                    if (candidateIndex == index) JsonObject(candidate.jsonObject - field) else candidate
                }
                val missing = JsonObject(root + ("results" to JsonArray(missingResults)))
                assertThrows(SerializationException::class.java) {
                    json.decodeFromJsonElement<GroupRecommendationResponse>(missing)
                }
            }
        }
    }

    @Test
    fun `display result type cannot represent prohibited fields`() {
        val fields = GroupRecommendationResult::class.java.declaredFields.map { it.name }.toSet()
        assertTrue(
            fields.intersect(
                setOf("resultToken", "actions", "location", "phone", "imageUrl", "aiAssisted"),
            ).isEmpty(),
        )
    }

    private fun validate(
        response: GroupRecommendationResponse,
        request: GroupRecommendationRequest,
        aggregation: GroupConstraintAggregation,
        expectedMode: DataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        expectedRuleVersion: String = "rule-v2",
    ): Boolean = GroupRecommendationResponseValidator.isValid(
        response = response,
        request = request,
        expectedAggregation = aggregation,
        expectedDataRightsMode = expectedMode,
        expectedRuleVersion = expectedRuleVersion,
    )

    private fun member(
        budget: Int?,
        minutes: Int,
        radius: Int,
        preferred: List<String> = emptyList(),
        excluded: List<String> = emptyList(),
    ) = GroupRecommendationMemberConstraints(
        budgetMaxYuan = budget,
        availableMinutes = minutes,
        radiusMeters = radius,
        preferredCuisines = preferred,
        excludedCuisines = excluded,
    )

    private fun response() = GroupRecommendationResponse(
        requestId = "123e4567-e89b-42d3-a456-426614174000",
        generatedAt = "2026-09-03T10:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-v2",
        aggregation = aggregation,
        results = listOf(result()),
        notice = "只读群组结果",
    )

    private fun result() = GroupRecommendationResult(
        provider = "DEMO",
        dataMode = RecommendationDataMode.DEMO,
        name = "群组候选一号",
        address = "虚构测试地址",
        rank = 1,
        fitScore = null,
        sourceRating = 4.2,
        averageCostYuan = 30.0,
        distanceMeters = 500.0,
        estimatedTravelMinutes = 8.0,
        estimatedMealMinutes = 30.0,
        openStatus = OpenStatus.OPEN,
        tags = listOf("面食"),
        reasons = listOf(RecommendationReason(ReasonCode.TIME_FIT, "符合共同时间范围")),
        warnings = emptyList(),
        confidence = Confidence.MEDIUM,
        sourceAttribution = "虚构演示数据",
    )
}
