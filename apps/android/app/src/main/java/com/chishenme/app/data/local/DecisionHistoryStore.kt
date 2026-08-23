package com.chishenme.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.chishenme.app.domain.DecisionInput
import java.io.IOException
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

internal val DecisionHistoryJson = stringPreferencesKey("decision_history_json_v1")

@Singleton
class DecisionHistoryStore @Inject constructor(
    private val dataStore: DataStore<Preferences>,
    json: Json,
) {
    private val codec = DecisionHistoryCodec(json)

    val entries: Flow<List<DecisionHistoryEntry>> = flow {
        // Collecting history is also a retention boundary: expired or malformed
        // data is removed from disk before the first value is shown.
        try {
            prunePersisted()
        } catch (_: IOException) {
            // The safe read below still yields an empty value for transient I/O.
        }
        emitAll(
            safeData.map { preferences ->
                DecisionHistoryPolicy.prune(
                    entries = codec.decodeOrEmpty(preferences[DecisionHistoryJson]),
                    now = Instant.now(),
                )
            },
        )
    }.distinctUntilChanged()

    suspend fun recordDecision(input: DecisionInput, resultCount: Int) {
        val now = Instant.now()
        val newEntry = DecisionHistoryEntry.from(input, resultCount, now)
        dataStore.edit { preferences ->
            val current = codec.decodeOrEmpty(preferences[DecisionHistoryJson])
            preferences[DecisionHistoryJson] = codec.encode(
                DecisionHistoryPolicy.prune(listOf(newEntry) + current, now),
            )
        }
    }

    suspend fun clear() {
        dataStore.edit { preferences -> preferences.remove(DecisionHistoryJson) }
    }

    private suspend fun prunePersisted() {
        val now = Instant.now()
        dataStore.edit { preferences ->
            val raw = preferences[DecisionHistoryJson] ?: return@edit
            val pruned = DecisionHistoryPolicy.prune(codec.decodeOrEmpty(raw), now)
            if (pruned.isEmpty()) {
                preferences.remove(DecisionHistoryJson)
            } else {
                val normalized = codec.encode(pruned)
                if (normalized != raw) preferences[DecisionHistoryJson] = normalized
            }
        }
    }

    private val safeData: Flow<Preferences>
        get() = dataStore.data.catch { error ->
            if (error is IOException) emit(androidx.datastore.preferences.core.emptyPreferences()) else throw error
        }
}
