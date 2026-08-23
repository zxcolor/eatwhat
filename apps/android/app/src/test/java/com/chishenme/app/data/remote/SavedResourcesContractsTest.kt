package com.chishenme.app.data.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SavedResourcesContractsTest {
    private val json = Json { encodeDefaults = true; explicitNulls = false }

    @Test
    fun `favorite creation serializes only proof idempotency key and group`() {
        val token = "A".repeat(43)
        val encoded = json.encodeToString(
            FavoriteMutationRequest(
                idempotencyKey = "33333333-3333-4333-8333-333333333333",
                result = RecommendationResultReferenceInput(
                    requestId = "11111111-1111-4111-8111-111111111111",
                    resultToken = token,
                ),
                group = FavoriteGroup.WANT_TO_GO,
            ),
        )
        val root = json.parseToJsonElement(encoded).jsonObject
        val result = root.getValue("result").jsonObject

        assertEquals(setOf("idempotencyKey", "result", "group"), root.keys)
        assertEquals(setOf("requestId", "resultToken"), result.keys)
        listOf(
            "providerPlaceId",
            "provider",
            "latitude",
            "longitude",
            "phone",
            "imageUrl",
            "address",
            "name",
        ).forEach { forbidden -> assertFalse(encoded.contains(forbidden)) }
        assertTrue(encoded.contains(token))
    }

    @Test
    fun `private feedback creation uses public feedback vocabulary only`() {
        val encoded = json.encodeToString(
            CreatePrivateFeedbackRequest(
                idempotencyKey = "33333333-3333-4333-8333-333333333333",
                result = RecommendationResultReferenceInput(
                    requestId = "11111111-1111-4111-8111-111111111111",
                    resultToken = "B".repeat(43),
                ),
                type = PrivateFeedbackType.RECENTLY_ATE,
            ),
        )

        assertTrue(encoded.contains("RECENTLY_ATE"))
        assertFalse(encoded.contains("ATE_RECENTLY"))
        assertFalse(encoded.contains("EXCLUDE_CUISINE"))
    }
}
