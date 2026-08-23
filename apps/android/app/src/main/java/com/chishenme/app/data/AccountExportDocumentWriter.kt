package com.chishenme.app.data

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

internal enum class AccountExportWriteResult {
    SUCCESS,
    INVALID_CONTENT,
    DESTINATION_UNAVAILABLE,
    TRANSFER_FAILED,
}

internal interface AccountExportDocumentWriter {
    fun supports(destinationUri: String): Boolean

    suspend fun write(
        destinationUri: String,
        input: InputStream,
        expectedSizeBytes: Long,
        expectedSha256: String,
    ): AccountExportWriteResult

    suspend fun discard(destinationUri: String)
}

/**
 * Writes only to a URI returned by Android's Storage Access Framework. The URI
 * and exported bytes are never copied into preferences, navigation state or a
 * log. No persistable URI permission is taken.
 */
@Singleton
internal class AndroidAccountExportDocumentWriter @Inject constructor(
    @ApplicationContext context: Context,
) : AccountExportDocumentWriter {
    private val resolver = context.contentResolver

    override fun supports(destinationUri: String): Boolean = validContentUri(destinationUri)

    override suspend fun write(
        destinationUri: String,
        input: InputStream,
        expectedSizeBytes: Long,
        expectedSha256: String,
    ): AccountExportWriteResult = withContext(Dispatchers.IO) {
        if (!supports(destinationUri)) return@withContext AccountExportWriteResult.DESTINATION_UNAVAILABLE
        val uri = Uri.parse(destinationUri)
        val output = try {
            resolver.openOutputStream(uri, "rwt")
                ?: return@withContext AccountExportWriteResult.DESTINATION_UNAVAILABLE
        } catch (_: Exception) {
            return@withContext AccountExportWriteResult.DESTINATION_UNAVAILABLE
        }
        try {
            val coroutineContext = currentCoroutineContext()
            // copyAndVerifyAccountExport already owns the single 32 KiB transfer
            // buffer and wipes it in finally. Wrapping this stream in
            // BufferedOutputStream would create a second JVM buffer whose bytes
            // cannot be explicitly cleared after a sensitive account export.
            output.use { destination ->
                copyAndVerifyAccountExport(
                    input = input,
                    output = destination,
                    expectedSizeBytes = expectedSizeBytes,
                    expectedSha256 = expectedSha256,
                    ensureActive = { coroutineContext.ensureActive() },
                )
            }
            AccountExportWriteResult.SUCCESS
        } catch (error: CancellationException) {
            throw error
        } catch (_: InvalidAccountExportContent) {
            AccountExportWriteResult.INVALID_CONTENT
        } catch (_: Exception) {
            AccountExportWriteResult.TRANSFER_FAILED
        }
    }

    override suspend fun discard(destinationUri: String) = withContext(Dispatchers.IO) {
        if (!supports(destinationUri)) return@withContext
        val uri = Uri.parse(destinationUri)
        val deleted = runCatching { DocumentsContract.deleteDocument(resolver, uri) }
            .getOrDefault(false)
        if (!deleted) {
            // Some document providers cannot delete a newly-created document.
            // Truncating it still prevents a partial export from being mistaken
            // for a valid file.
            runCatching { resolver.openOutputStream(uri, "rwt")?.use { } }
        }
    }

    private fun validContentUri(raw: String): Boolean {
        if (raw.length !in 1..MAX_DESTINATION_URI_LENGTH) return false
        val parsed = runCatching { URI(raw) }.getOrNull() ?: return false
        return parsed.scheme.equals("content", ignoreCase = true) &&
            !parsed.rawAuthority.isNullOrBlank() &&
            parsed.userInfo == null &&
            parsed.fragment == null
    }

    private companion object {
        const val MAX_DESTINATION_URI_LENGTH = 4_096
        const val BUFFER_SIZE = 32 * 1_024
    }
}

internal fun copyAndVerifyAccountExport(
    input: InputStream,
    output: OutputStream,
    expectedSizeBytes: Long,
    expectedSha256: String,
    ensureActive: () -> Unit = {},
) {
    if (expectedSizeBytes !in 1..com.chishenme.app.data.remote.AccountExportContract.MAX_ARTIFACT_BYTES ||
        !expectedSha256.matches(Regex("^[0-9a-f]{64}$"))
    ) {
        throw InvalidAccountExportContent()
    }
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(32 * 1_024)
    try {
        var copied = 0L
        var consecutiveEmptyReads = 0
        while (true) {
            ensureActive()
            val count = input.read(buffer)
            if (count == -1) break
            if (count == 0) {
                consecutiveEmptyReads += 1
                if (consecutiveEmptyReads > MAX_CONSECUTIVE_EMPTY_READS) {
                    throw InvalidAccountExportContent()
                }
                continue
            }
            consecutiveEmptyReads = 0
            copied += count
            if (copied > expectedSizeBytes || copied > com.chishenme.app.data.remote.AccountExportContract.MAX_ARTIFACT_BYTES) {
                throw InvalidAccountExportContent()
            }
            digest.update(buffer, 0, count)
            output.write(buffer, 0, count)
        }
        output.flush()
        val actualSha256 = digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        if (copied != expectedSizeBytes || actualSha256 != expectedSha256) {
            throw InvalidAccountExportContent()
        }
    } finally {
        buffer.fill(0)
    }
}

internal class InvalidAccountExportContent : Exception()

private const val MAX_CONSECUTIVE_EMPTY_READS = 16
