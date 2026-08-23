package com.chishenme.app.data.remote

import java.time.Instant
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountExportContractTest {
    @Test
    fun `request explicitly serializes the behavior history choice`() {
        val encoded = Json.encodeToString(
            AccountExportRequest(format = "JSON", includeBehaviorHistory = false),
        )

        assertEquals("{\"format\":\"JSON\",\"includeBehaviorHistory\":false}", encoded)
        assertTrue(AccountExportContract.isCanonicalUuid(ID))
        assertFalse(AccountExportContract.isCanonicalUuid(ID.uppercase()))
    }

    @Test
    fun `ready status requires complete bounded artifact metadata`() {
        val now = Instant.parse("2026-08-21T08:00:00Z")
        val ready = readyStatus(now)

        assertTrue(AccountExportContract.validStatus(ready, ID, now))
        assertFalse(AccountExportContract.validStatus(ready.copy(downloadAvailable = false), ID, now))
        assertFalse(AccountExportContract.validStatus(ready.copy(sizeBytes = 10_485_761), ID, now))
        assertFalse(AccountExportContract.validStatus(ready.copy(sha256 = "A".repeat(64)), ID, now))
        assertFalse(AccountExportContract.validStatus(ready.copy(contentType = "application/zip"), ID, now))
        assertFalse(AccountExportContract.validStatus(ready.copy(exportId = OTHER_ID), ID, now))
    }

    @Test
    fun `non-ready states cannot smuggle artifact fields or unknown failure details`() {
        val now = Instant.parse("2026-08-21T08:00:00Z")
        val queued = readyStatus(now).copy(
            status = AccountExportStatus.QUEUED,
            downloadAvailable = false,
            readyAt = null,
            sizeBytes = null,
            sha256 = null,
            contentType = null,
        )

        assertTrue(AccountExportContract.validStatus(queued, now = now))
        assertFalse(
            AccountExportContract.validStatus(
                queued.copy(sha256 = "0".repeat(64)),
                now = now,
            ),
        )
        assertFalse(
            AccountExportContract.validStatus(
                queued.copy(failureCode = "debug stack"),
                now = now,
            ),
        )
        assertTrue(
            AccountExportContract.validStatus(
                queued.copy(status = AccountExportStatus.FAILED, failureCode = "GENERATION_FAILED"),
                now = now,
            ),
        )
        assertFalse(
            AccountExportContract.validStatus(
                queued.copy(status = AccountExportStatus.FAILED, failureCode = "OSS_SECRET"),
                now = now,
            ),
        )
    }

    private fun readyStatus(now: Instant) = AccountExportStatusResponse(
        exportId = ID,
        status = AccountExportStatus.READY,
        requestedAt = now.minusSeconds(60).toString(),
        expiresAt = now.plusSeconds(600).toString(),
        includeBehaviorHistory = true,
        downloadAvailable = true,
        readyAt = now.minusSeconds(30).toString(),
        sizeBytes = 128,
        sha256 = "0".repeat(64),
        contentType = "application/json",
    )

    private companion object {
        const val ID = "0192f014-7d64-4b59-8fc1-513465daae10"
        const val OTHER_ID = "0192f014-7d64-4b59-8fc1-513465daae11"
    }
}
