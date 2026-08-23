package com.chishenme.app.data.local

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.domain.DecisionInput
import com.chishenme.app.domain.LocationChoice
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DecisionHistoryTest {
    private val json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }
    private val codec = DecisionHistoryCodec(json)
    private val now = Instant.parse("2026-08-20T12:00:00Z")

    @Test
    fun `serializes only the local decision summary allowlist`() {
        val input = DecisionInput(
            location = LocationChoice(
                label = "不应写入的地点",
                coordinate = Coordinate(
                    latitude = 39.9928,
                    longitude = 116.3109,
                    crs = CoordinateReferenceSystem.WGS84,
                ),
            ),
            mealPeriod = MealPeriod.LUNCH,
            decisionMode = DecisionMode.GUIDED,
            travelMode = TravelMode.BIKE,
            explorationMode = ExplorationMode.ADVENTUROUS,
            budgetMaxYuan = 42,
            availableMinutes = 55,
            radiusMeters = 2_000,
            partySize = 2,
            excludedCuisines = setOf("不应写入的排除偏好"),
            preferredCuisines = setOf("不应写入的菜系偏好"),
        )
        val entry = DecisionHistoryEntry.from(input, resultCount = 7, recordedAt = now)

        val encoded = codec.encode(listOf(entry))
        val decoded = codec.decodeOrEmpty(encoded)
        val root = json.parseToJsonElement(encoded).jsonObject
        val storedEntry = root.getValue("entries").jsonArray.single().jsonObject

        assertEquals(listOf(entry), decoded)
        assertEquals(setOf("schemaVersion", "entries"), root.keys)
        assertEquals(
            setOf(
                "recordedAtEpochMillis",
                "mealPeriod",
                "decisionMode",
                "budgetMaxYuan",
                "availableMinutes",
                "travelMode",
                "resultCount",
            ),
            storedEntry.keys,
        )
        listOf(
            "latitude",
            "longitude",
            "location",
            "address",
            "phone",
            "providerPlaceId",
            "resultToken",
            "imageUrl",
            "radiusMeters",
            "partySize",
            "excludedCuisines",
            "preferredCuisines",
            "不应写入",
        ).forEach { forbidden -> assertFalse(encoded.contains(forbidden)) }
    }

    @Test
    fun `retains entries at 90 day boundary and removes older entries`() {
        val atBoundary = entryAt(now.minus(Duration.ofDays(90)))
        val tooOld = entryAt(now.minus(Duration.ofDays(90)).minusMillis(1))

        val retained = DecisionHistoryPolicy.prune(
            entries = listOf(tooOld, atBoundary),
            now = now,
        )

        assertEquals(listOf(atBoundary), retained)
    }

    @Test
    fun `keeps only the newest 30 entries`() {
        val entries = (0 until 35).map { offset -> entryAt(now.minusSeconds(offset.toLong())) }

        val retained = DecisionHistoryPolicy.prune(entries, now)

        assertEquals(30, retained.size)
        assertEquals(entries.take(30), retained)
        assertTrue(retained.zipWithNext().all { (first, second) ->
            first.recordedAtEpochMillis >= second.recordedAtEpochMillis
        })
    }

    @Test
    fun `invalid or future schema payload decodes as empty`() {
        assertTrue(codec.decodeOrEmpty("not-json").isEmpty())
        assertTrue(codec.decodeOrEmpty("{\"schemaVersion\":2,\"entries\":[]}").isEmpty())
    }

    private fun entryAt(instant: Instant) = DecisionHistoryEntry(
        recordedAtEpochMillis = instant.toEpochMilli(),
        mealPeriod = MealPeriod.DINNER,
        decisionMode = DecisionMode.QUICK,
        budgetMaxYuan = null,
        availableMinutes = 60,
        travelMode = TravelMode.WALK,
        resultCount = 3,
    )
}
