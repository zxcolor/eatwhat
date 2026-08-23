package com.chishenme.app.feature.detail

import java.io.File

/** Owns the single private cache subtree exposed by the share FileProvider. */
internal class RestaurantShareCardStore(
    cacheDirectory: File,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    private val shareDirectory = File(cacheDirectory, SHARE_DIRECTORY_NAME)

    fun createOutputFile(): File {
        cleanupExpired()
        check(shareDirectory.exists() || shareDirectory.mkdirs()) {
            "Unable to create share-card cache directory"
        }
        check(shareDirectory.isDirectory) { "Share-card cache path is not a directory" }
        val outputFile = File.createTempFile(FILE_PREFIX, FILE_SUFFIX, shareDirectory)
        return try {
            activeGenerationLease.get()?.register(outputFile)
            outputFile
        } catch (failure: Exception) {
            outputFile.delete()
            throw failure
        } catch (failure: OutOfMemoryError) {
            outputFile.delete()
            throw failure
        }
    }

    fun cleanupExpired(): Int {
        val cutoff = nowMillis() - MAX_AGE_MILLIS
        val files = shareDirectory.listFiles() ?: return 0
        var deleted = 0
        files.forEach { candidate ->
            // Never recurse or follow user-controlled paths. Only files that
            // this component creates directly under its dedicated directory
            // are eligible for deletion.
            if (
                candidate.parentFile == shareDirectory &&
                candidate.isFile &&
                candidate.name.startsWith(FILE_PREFIX) &&
                candidate.name.endsWith(FILE_SUFFIX) &&
                candidate.lastModified() < cutoff &&
                candidate.delete()
            ) {
                deleted += 1
            }
        }
        return deleted
    }

    internal companion object {
        const val SHARE_DIRECTORY_NAME = "share_cards"
        const val MAX_AGE_MILLIS = 24L * 60L * 60L * 1_000L
        const val FILE_PREFIX = "restaurant_"
        const val FILE_SUFFIX = ".png"

        private val activeGenerationLease = ThreadLocal<GenerationLease?>()

        /**
         * Creates an operation-local owner for the one output file a share-card
         * generation may create. The owner survives a dispatcher hand-off, so a
         * caller can still remove the file when `withContext` delivers prompt
         * cancellation instead of returning the generated [File].
         */
        fun generationLease(cacheDirectory: File): GenerationLease =
            GenerationLease(File(cacheDirectory, SHARE_DIRECTORY_NAME))

        /**
         * Binds [lease] only to synchronous work on the current worker thread.
         * RestaurantShareCardGenerator performs no suspension while it renders,
         * so unrelated concurrent generations cannot be claimed or deleted.
         */
        fun <T> withGenerationLease(lease: GenerationLease, block: () -> T): T {
            check(activeGenerationLease.get() == null) { "A share-card generation lease is already active" }
            activeGenerationLease.set(lease)
            return try {
                block()
            } finally {
                activeGenerationLease.remove()
            }
        }
    }

    internal class GenerationLease(
        private val ownedDirectory: File,
    ) {
        @Volatile
        private var outputFile: File? = null

        @Synchronized
        internal fun register(candidate: File) {
            check(isOwnedGeneratedFile(candidate)) { "Share-card output escaped its dedicated directory" }
            check(outputFile == null) { "A share-card generation created more than one output file" }
            outputFile = candidate
        }

        @Synchronized
        fun owns(candidate: File?): Boolean =
            candidate != null && outputFile == candidate && isOwnedGeneratedFile(candidate)

        /** Removes only the exact file registered by this generation. */
        @Synchronized
        fun discard(): Boolean {
            val candidate = outputFile ?: return true
            outputFile = null
            if (!isOwnedGeneratedFile(candidate)) return false
            return !candidate.exists() || candidate.delete()
        }

        /** Transfers ownership only after the Android chooser has started. */
        @Synchronized
        fun release(candidate: File): Boolean {
            if (outputFile != candidate || !isOwnedGeneratedFile(candidate)) return false
            outputFile = null
            return true
        }

        private fun isOwnedGeneratedFile(candidate: File): Boolean =
            candidate.parentFile == ownedDirectory &&
                candidate.name.startsWith(FILE_PREFIX) &&
                candidate.name.endsWith(FILE_SUFFIX)
    }
}
