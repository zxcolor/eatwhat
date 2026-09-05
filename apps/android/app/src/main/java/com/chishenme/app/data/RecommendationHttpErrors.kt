package com.chishenme.app.data

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import retrofit2.HttpException

/** Only this fixed code affects guidance; arbitrary server messages never reach the UI. */
internal fun HttpException.isActiveCoverageRejection(): Boolean {
    if (code() != 400) return false
    val body = response()?.errorBody() ?: return false
    return try {
        body.use { errorBody ->
            val declaredLength = errorBody.contentLength()
            if (declaredLength > MAX_COVERAGE_ERROR_BYTES || declaredLength < -1L) return false
            val source = errorBody.source()
            source.request(MAX_COVERAGE_ERROR_BYTES + 1L)
            if (source.buffer.size > MAX_COVERAGE_ERROR_BYTES) return false
            val raw = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(source.buffer.clone().readByteArray()))
                .toString()
            val parsed = COVERAGE_ERROR_JSON.decodeFromString<CoverageErrorResponse>(raw)
            UUID.fromString(parsed.requestId).toString() == parsed.requestId &&
                parsed.code == "RADIUS_EXCEEDS_ACTIVE_COVERAGE"
        }
    } catch (_: Exception) {
        false
    }
}

@Serializable
private data class CoverageErrorResponse(
    val requestId: String,
    val code: String,
    val message: String,
)

private const val MAX_COVERAGE_ERROR_BYTES = 4L * 1_024L
private val COVERAGE_ERROR_JSON = Json {
    ignoreUnknownKeys = false
    isLenient = false
}
