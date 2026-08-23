package com.chishenme.app.feature.detail

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RestaurantShareCardStoreTest {
    @Test
    fun cleanupDeletesOnlyExpiredGeneratedPngsInsideDedicatedDirectory() {
        val root = Files.createTempDirectory("share-card-store").toFile()
        try {
            val now = 2_000_000_000_000L
            val shareDirectory = root.resolve(RestaurantShareCardStore.SHARE_DIRECTORY_NAME)
            assertTrue(shareDirectory.mkdirs())
            val oldCard = shareDirectory.resolve("${RestaurantShareCardStore.FILE_PREFIX}old.png")
            val freshCard = shareDirectory.resolve("${RestaurantShareCardStore.FILE_PREFIX}fresh.png")
            val unrelated = shareDirectory.resolve("unrelated.png")
            val outside = root.resolve("${RestaurantShareCardStore.FILE_PREFIX}outside.png")
            listOf(oldCard, freshCard, unrelated, outside).forEach { it.writeBytes(byteArrayOf(1)) }
            assertTrue(oldCard.setLastModified(now - RestaurantShareCardStore.MAX_AGE_MILLIS - 1L))
            assertTrue(freshCard.setLastModified(now - RestaurantShareCardStore.MAX_AGE_MILLIS + 1L))
            assertTrue(unrelated.setLastModified(now - RestaurantShareCardStore.MAX_AGE_MILLIS - 1L))
            assertTrue(outside.setLastModified(now - RestaurantShareCardStore.MAX_AGE_MILLIS - 1L))

            val deleted = RestaurantShareCardStore(root) { now }.cleanupExpired()

            assertEquals(1, deleted)
            assertFalse(oldCard.exists())
            assertTrue(freshCard.exists())
            assertTrue(unrelated.exists())
            assertTrue(outside.exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun generatedFileHasOpaqueNameAndLivesInTheOnlySharedSubdirectory() {
        val root = Files.createTempDirectory("share-card-create").toFile()
        try {
            val output = RestaurantShareCardStore(root).createOutputFile()

            assertEquals(
                RestaurantShareCardStore.SHARE_DIRECTORY_NAME,
                requireNotNull(output.parentFile).name,
            )
            assertTrue(output.name.startsWith(RestaurantShareCardStore.FILE_PREFIX))
            assertTrue(output.name.endsWith(RestaurantShareCardStore.FILE_SUFFIX))
            assertFalse(output.name.contains("AMAP"))
            assertFalse(output.name.contains("resultToken"))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun generationLeaseDiscardsOnlyItsRegisteredOutput() {
        val root = Files.createTempDirectory("share-card-lease").toFile()
        try {
            val shareDirectory = root.resolve(RestaurantShareCardStore.SHARE_DIRECTORY_NAME)
            assertTrue(shareDirectory.mkdirs())
            val unrelated = shareDirectory.resolve("unrelated.png").apply {
                writeBytes(byteArrayOf(9))
            }
            val outside = root.resolve(RestaurantShareCardStore.FILE_PREFIX + "outside.png").apply {
                writeBytes(byteArrayOf(8))
            }
            val lease = RestaurantShareCardStore.generationLease(root)
            val generated = RestaurantShareCardStore.withGenerationLease(lease) {
                RestaurantShareCardStore(root).createOutputFile().apply {
                    writeBytes(byteArrayOf(1, 2, 3))
                }
            }

            assertTrue(lease.owns(generated))
            assertTrue(lease.discard())
            assertFalse(generated.exists())
            assertTrue(unrelated.exists())
            assertTrue(outside.exists())
        } finally {
            root.deleteRecursively()
        }
    }
}
