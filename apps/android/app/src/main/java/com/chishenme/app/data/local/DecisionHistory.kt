package com.chishenme.app.data.local

import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.domain.DecisionInput
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Privacy-minimal local history. This type intentionally cannot represent a
 * location, a place identifier, or any third-party POI attribute.
 */
@Serializable
data class DecisionHistoryEntry(
    val recordedAtEpochMillis: Long,
    val mealPeriod: MealPeriod,
    val decisionMode: DecisionMode,
    val budgetMaxYuan: Int? = null,
    val availableMinutes: Int,
    val travelMode: TravelMode,
    val resultCount: Int,
) {
    companion object {
        fun from(
            input: DecisionInput,
            resultCount: Int,
            recordedAt: Instant = Instant.now(),
        ): DecisionHistoryEntry = DecisionHistoryEntry(
            recordedAtEpochMillis = recordedAt.toEpochMilli(),
            mealPeriod = input.mealPeriod,
            decisionMode = input.decisionMode,
            budgetMaxYuan = input.budgetMaxYuan,
            availableMinutes = input.availableMinutes,
            travelMode = input.travelMode,
            resultCount = resultCount.coerceAtLeast(0),
        )
    }
}

@Serializable
private data class DecisionHistoryPayload(
    val schemaVersion: Int = CURRENT_SCHEMA_VERSION,
    val entries: List<DecisionHistoryEntry>,
)

internal class DecisionHistoryCodec(
    private val json: Json,
) {
    fun encode(entries: List<DecisionHistoryEntry>): String =
        json.encodeToString(DecisionHistoryPayload(entries = entries))

    fun decodeOrEmpty(raw: String?): List<DecisionHistoryEntry> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching { json.decodeFromString<DecisionHistoryPayload>(raw) }
            .getOrNull()
            ?.takeIf { it.schemaVersion == CURRENT_SCHEMA_VERSION }
            ?.entries
            .orEmpty()
    }
}

internal object DecisionHistoryPolicy {
    const val MAX_ENTRIES = 30
    val RETENTION: Duration = Duration.ofDays(90)

    fun prune(
        entries: List<DecisionHistoryEntry>,
        now: Instant,
    ): List<DecisionHistoryEntry> {
        val cutoffEpochMillis = now.minus(RETENTION).toEpochMilli()
        return entries.asSequence()
            .filter { entry -> entry.recordedAtEpochMillis >= cutoffEpochMillis }
            .sortedByDescending(DecisionHistoryEntry::recordedAtEpochMillis)
            .take(MAX_ENTRIES)
            .toList()
    }
}

private const val CURRENT_SCHEMA_VERSION = 1
