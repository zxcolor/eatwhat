package com.chishenme.app.data.remote

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class AccountExportRequest(
    val format: String,
    val includeBehaviorHistory: Boolean,
)

@Serializable
data class AccountExportResponse(
    val exportId: String,
    val status: AccountExportStatus,
    val requestedAt: String,
    val expiresAt: String,
    val includeBehaviorHistory: Boolean,
)

@Serializable
enum class AccountExportStatus { QUEUED, PROCESSING, READY, FAILED, EXPIRED }

@Serializable
data class AccountExportStatusResponse(
    val exportId: String,
    val status: AccountExportStatus,
    val requestedAt: String,
    val expiresAt: String,
    val includeBehaviorHistory: Boolean,
    val downloadAvailable: Boolean,
    val readyAt: String? = null,
    val sizeBytes: Long? = null,
    val sha256: String? = null,
    val contentType: String? = null,
    val failureCode: String? = null,
)

@Serializable
data class AccountExportLatestResponse(
    val item: AccountExportStatusResponse?,
)

/** Strict semantic checks applied after kotlinx.serialization's shape check. */
internal object AccountExportContract {
    private val sha256 = Regex("^[0-9a-f]{64}$")

    fun validQueuedReceipt(
        response: AccountExportResponse,
        expectedIncludeBehaviorHistory: Boolean,
        now: Instant = Instant.now(),
    ): Boolean {
        val requestedAt = response.requestedAt.asInstant() ?: return false
        val expiresAt = response.expiresAt.asInstant() ?: return false
        return isCanonicalUuid(response.exportId) &&
            response.status == AccountExportStatus.QUEUED &&
            response.includeBehaviorHistory == expectedIncludeBehaviorHistory &&
            !requestedAt.isAfter(now.plusSeconds(CLOCK_SKEW_SECONDS)) &&
            expiresAt.isAfter(now.minusSeconds(CLOCK_SKEW_SECONDS)) &&
            validLifetime(requestedAt, expiresAt)
    }

    fun validStatus(
        response: AccountExportStatusResponse,
        expectedExportId: String? = null,
        now: Instant = Instant.now(),
    ): Boolean {
        val requestedAt = response.requestedAt.asInstant() ?: return false
        val expiresAt = response.expiresAt.asInstant() ?: return false
        if (!isCanonicalUuid(response.exportId) ||
            (expectedExportId != null && response.exportId != expectedExportId.lowercase()) ||
            requestedAt.isAfter(now.plusSeconds(CLOCK_SKEW_SECONDS)) ||
            !validLifetime(requestedAt, expiresAt)
        ) {
            return false
        }

        val hasNoArtifact = response.readyAt == null &&
            response.sizeBytes == null &&
            response.sha256 == null &&
            response.contentType == null
        return when (response.status) {
            AccountExportStatus.QUEUED,
            AccountExportStatus.PROCESSING,
            -> !response.downloadAvailable && hasNoArtifact && response.failureCode == null

            AccountExportStatus.READY -> {
                val readyAt = response.readyAt?.asInstant() ?: return false
                response.downloadAvailable &&
                    !readyAt.isBefore(requestedAt) &&
                    readyAt.isBefore(expiresAt) &&
                    expiresAt.isAfter(now.minusSeconds(CLOCK_SKEW_SECONDS)) &&
                    response.sizeBytes?.let { it in 1..MAX_ARTIFACT_BYTES } == true &&
                    response.sha256?.matches(sha256) == true &&
                    response.contentType == CONTENT_TYPE &&
                    response.failureCode == null
            }

            AccountExportStatus.FAILED -> !response.downloadAvailable &&
                hasNoArtifact &&
                response.failureCode == "GENERATION_FAILED"

            AccountExportStatus.EXPIRED -> !response.downloadAvailable &&
                hasNoArtifact &&
                response.failureCode == null
        }
    }

    fun isCanonicalUuid(value: String): Boolean = runCatching {
        val parsed = UUID.fromString(value)
        parsed.toString() == value && parsed.version() == 4 && parsed.variant() == 2
    }.getOrDefault(false)

    private fun validLifetime(requestedAt: Instant, expiresAt: Instant): Boolean =
        expiresAt.isAfter(requestedAt) &&
            expiresAt <= requestedAt.plusSeconds(RETENTION_SECONDS + CLOCK_SKEW_SECONDS)

    private fun String.asInstant(): Instant? = runCatching(Instant::parse).getOrNull()

    const val CONTENT_TYPE = "application/json"
    const val MAX_ARTIFACT_BYTES = 10_485_760L
    private const val RETENTION_SECONDS = 7 * 24 * 60 * 60L
    private const val CLOCK_SKEW_SECONDS = 30L
}
