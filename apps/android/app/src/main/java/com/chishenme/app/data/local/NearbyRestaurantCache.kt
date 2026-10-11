package com.chishenme.app.data.local

import android.content.Context
import android.util.AtomicFile
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.NearbyRestaurant
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

internal const val NearbyRetentionMillis = 90L * 24 * 60 * 60 * 1000

@Serializable
data class NearbyRestaurantSnapshot(
    val startedAtMillis: Long,
    val updatedAtMillis: Long,
    val radiusMeters: Int = 3500,
    val retentionDays: Int = 90,
    val status: String = "COLLECTING",
    val pagesCollected: Int = 0,
    val limited: Boolean = false,
    val restaurants: List<NearbyRestaurant> = emptyList(),
    val userLocation: Coordinate? = null,
)

internal fun nearbySnapshotExpired(startedAtMillis: Long, now: Long): Boolean =
    startedAtMillis <= 0 || startedAtMillis > now || now - startedAtMillis >= NearbyRetentionMillis

/** Each opening owns one timestamp-named file in the same private directory. */
@Singleton
class NearbyRestaurantCache @Inject constructor(
    @ApplicationContext context: Context,
    json: Json,
) {
    // Local records explicitly preserve unknown accuracy as null. Network JSON
    // continues to omit optional fields under the existing HTTP contract.
    @OptIn(ExperimentalSerializationApi::class)
    private val storageJson = Json(json) { explicitNulls = true }
    private val root = File(context.filesDir, "nearby_restaurants")
    private val mutex = Mutex()

    suspend fun create(startedAtMillis: Long, userLocation: Coordinate): String = withContext(Dispatchers.IO) {
        mutex.withLock {
            pruneLocked(System.currentTimeMillis())
            if (!root.exists() && !root.mkdirs()) throw IOException("Cache directory unavailable")
            require(startedAtMillis > 0)
            var timestamp = startedAtMillis
            while (sessionFile(timestamp.toString()).exists() || File(root, "$timestamp.json.bak").exists()) timestamp++
            val session = timestamp.toString()
            // A clock collision or explicit retry must never overwrite a file
            // already owned by another collection.
            writeLocked(sessionFile(session), NearbyRestaurantSnapshot(
                startedAtMillis, System.currentTimeMillis(), userLocation = userLocation,
            ))
            session
        }
    }

    suspend fun append(session: String, restaurants: List<NearbyRestaurant>, page: Int) =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val file = sessionFile(session)
                val current = readLocked(file)
                if (nearbySnapshotExpired(current.startedAtMillis, System.currentTimeMillis())) {
                    AtomicFile(file).delete()
                    throw IOException("Cache session expired")
                }
                val combined = (current.restaurants + restaurants)
                    .associateBy { it.provider to it.providerPlaceId }.values.toList()
                writeLocked(file, current.copy(
                    updatedAtMillis = System.currentTimeMillis(), pagesCollected = page,
                    restaurants = combined,
                ))
                combined.size
            }
        }

    suspend fun finish(session: String, complete: Boolean, limited: Boolean = false) = withContext(Dispatchers.IO) {
        mutex.withLock {
            val file = sessionFile(session)
            if (file.exists()) writeLocked(file, readLocked(file).copy(
                updatedAtMillis = System.currentTimeMillis(), status = if (complete) "COMPLETE" else "PARTIAL", limited = limited,
            ))
        }
    }

    /** Every read physically removes expired files before exposing data. */
    suspend fun snapshots(): List<NearbyRestaurantSnapshot> = withContext(Dispatchers.IO) {
        mutex.withLock {
            pruneLocked(System.currentTimeMillis())
            root.listFiles().orEmpty().filter { it.name.endsWith(".json") }
                .mapNotNull { runCatching { readLocked(it) }.getOrNull() }
                .sortedByDescending { it.startedAtMillis }
        }
    }

    suspend fun prune() = withContext(Dispatchers.IO) { mutex.withLock { pruneLocked(System.currentTimeMillis()) } }
    suspend fun clear() = withContext(Dispatchers.IO) {
        mutex.withLock { if (root.exists() && !root.deleteRecursively()) throw IOException("Cache cleanup failed") }
    }

    private fun sessionFile(session: String): File {
        require(session.matches(Regex("[0-9]{1,19}")))
        return File(root, "$session.json")
    }

    private fun pruneLocked(now: Long) {
        root.listFiles().orEmpty().filter { it.name.endsWith(".json") || it.name.endsWith(".json.bak") || it.name.endsWith(".json.new") }
            .map { File(root, it.name.removeSuffix(".bak").removeSuffix(".new")) }.distinct().forEach { file ->
            val timestamp = runCatching { readLocked(file).startedAtMillis }.getOrNull()
            if (timestamp == null || nearbySnapshotExpired(timestamp, now)) {
                AtomicFile(file).delete()
                if (file.exists() || File(root, "${file.name}.bak").exists()) throw IOException("Cache expiry cleanup failed")
            }
        }
    }

    private fun readLocked(file: File): NearbyRestaurantSnapshot =
        AtomicFile(file).openRead().bufferedReader().use {
            storageJson.decodeFromString<NearbyRestaurantSnapshot>(it.readText())
        }

    private fun writeLocked(target: File, snapshot: NearbyRestaurantSnapshot) {
        val file = AtomicFile(target)
        val stream = file.startWrite()
        try {
            stream.write(storageJson.encodeToString(snapshot).toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }
}
