package com.chishenme.app.data.remote

import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
enum class SupportFeedbackCategory {
    PRODUCT,
    PLACE_CORRECTION,
    PRIVACY,
    COMPLAINT,
}

@Serializable
data class SupportFeedbackRequest(
    val submissionId: String,
    val category: SupportFeedbackCategory,
    val message: String,
)

@Serializable
data class SupportFeedbackResponse(
    val feedbackId: String,
    val accepted: Boolean,
    val retentionAfterClosureDays: Int,
)

internal object SupportFeedbackContract {
    fun normalizeMessage(raw: String): String = trimEcmaWhitespace(
        raw
        .replace("\r\n", "\n")
        .replace('\r', '\n'),
    )

    fun limitDraft(raw: String, maximumCodePoints: Int = 2_200): String {
        if (raw.codePointCount(0, raw.length) <= maximumCodePoints) return raw
        return raw.substring(0, raw.offsetByCodePoints(0, maximumCodePoints))
    }

    fun isValidMessage(raw: String): Boolean {
        val normalized = normalizeMessage(raw)
        val count = normalized.codePointCount(0, normalized.length)
        if (count !in 10..2_000) return false

        var index = 0
        while (index < normalized.length) {
            val codePoint = Character.codePointAt(normalized, index)
            if (
                codePoint <= 0x08 ||
                codePoint in 0x0b..0x1f ||
                codePoint in 0x7f..0x9f
            ) {
                return false
            }
            index += Character.charCount(codePoint)
        }
        return true
    }

    fun isUuidV4(value: String): Boolean = UUID_V4.matches(value)

    fun isCanonicalUuid(value: String): Boolean = runCatching {
        UUID.fromString(value).toString() == value.lowercase()
    }.getOrDefault(false)

    fun isValidResponse(
        response: SupportFeedbackResponse,
        expectedSubmissionId: String,
    ): Boolean = response.accepted &&
        response.retentionAfterClosureDays == 180 &&
        isCanonicalUuid(response.feedbackId) &&
        response.feedbackId == expectedSubmissionId.lowercase()

    private val UUID_V4 = Regex(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    )

    private fun trimEcmaWhitespace(value: String): String {
        var start = 0
        var end = value.length
        while (start < end) {
            val codePoint = Character.codePointAt(value, start)
            if (!isEcmaWhitespace(codePoint)) break
            start += Character.charCount(codePoint)
        }
        while (end > start) {
            val codePoint = Character.codePointBefore(value, end)
            if (!isEcmaWhitespace(codePoint)) break
            end -= Character.charCount(codePoint)
        }
        return value.substring(start, end)
    }

    private fun isEcmaWhitespace(codePoint: Int): Boolean =
        codePoint in 0x09..0x0d ||
            codePoint == 0x20 ||
            codePoint == 0x00a0 ||
            codePoint == 0x1680 ||
            codePoint in 0x2000..0x200a ||
            codePoint == 0x2028 ||
            codePoint == 0x2029 ||
            codePoint == 0x202f ||
            codePoint == 0x205f ||
            codePoint == 0x3000 ||
            codePoint == 0xfeff
}
