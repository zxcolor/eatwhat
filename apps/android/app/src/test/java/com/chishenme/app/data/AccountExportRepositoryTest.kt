package com.chishenme.app.data

import com.chishenme.app.data.remote.AccountExportApi
import com.chishenme.app.data.remote.AccountExportContentApi
import com.chishenme.app.data.remote.AccountExportLatestResponse
import com.chishenme.app.data.remote.AccountExportRequest
import com.chishenme.app.data.remote.AccountExportResponse
import com.chishenme.app.data.remote.AccountExportStatus
import com.chishenme.app.data.remote.AccountExportStatusResponse
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import okhttp3.Headers.Companion.toHeaders
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class AccountExportRepositoryTest {
    @Test
    fun `request sends the explicit scope with ephemeral bearer`() = runTest {
        val api = FakeApi()
        val auth = FakeGenerationAuth()
        val repository = repository(api, auth)

        val outcome = repository.request(includeBehaviorHistory = false)

        assertTrue(outcome is AccountExportOutcome.Success)
        assertEquals("Bearer ephemeral", api.authorization)
        assertEquals(AccountExportRequest("JSON", false), api.request)
    }

    @Test
    fun `latest null cleanly represents no export task`() = runTest {
        val api = FakeApi().apply {
            latestResponse = Response.success(AccountExportLatestResponse(null))
        }

        val outcome = repository(api).latest()

        assertNull((outcome as AccountExportOutcome.Success).value)
    }

    @Test
    fun `authenticated 401 invalidates only the captured generation`() = runTest {
        val api = FakeApi().apply {
            latestResponse = Response.error(401, "ignored".toResponseBody())
        }
        val auth = FakeGenerationAuth()

        val outcome = repository(api, auth).latest()

        assertEquals(
            AccountExportFailureKind.LOGIN_STATE,
            (outcome as AccountExportOutcome.Failure).kind,
        )
        assertEquals(listOf(17L), auth.invalidatedGenerations)
    }

    @Test
    fun `late 401 from old account does not clear a newer account`() = runTest {
        val api = FakeApi().apply {
            latestResponse = Response.error(401, "ignored".toResponseBody())
        }
        val auth = FakeGenerationAuth().apply {
            afterCall = { switchAccount("user-b", "session-b") }
        }

        val outcome = repository(api, auth).latest()

        assertEquals(
            AccountExportFailureKind.LOGIN_STATE,
            (outcome as AccountExportOutcome.Failure).kind,
        )
        assertEquals(listOf(17L), auth.invalidatedGenerations)
        assertEquals("user-b", auth.currentUserId)
        assertEquals("session-b", auth.currentSessionId)
        assertEquals(18L, auth.currentGeneration)
    }

    @Test
    fun `ready content is streamed only after every fixed header is verified`() = runTest {
        val bytes = "{\"account\":{\"status\":\"ACTIVE\"}}".encodeToByteArray()
        val status = readyStatus(bytes)
        val api = FakeApi().apply { contentResponse = contentResponse(bytes) }
        val writer = FakeWriter()

        val outcome = repository(api, writer = writer).download(status, DESTINATION)

        assertTrue(outcome is AccountExportOutcome.Success)
        assertEquals("Bearer ephemeral", api.authorization)
        assertEquals(status.exportId, api.contentExportId)
        assertTrue(writer.written)
        assertFalse(writer.discarded)
        assertEquals(bytes.decodeToString(), writer.content.decodeToString())
    }

    @Test
    fun `late 200 is rejected before writing when the account changed in flight`() = runTest {
        val bytes = "{\"account\":{\"status\":\"ACTIVE\"}}".encodeToByteArray()
        val auth = FakeGenerationAuth().apply {
            afterCall = { switchAccount("user-b", "session-b") }
        }
        val writer = FakeWriter()

        val outcome = repository(
            FakeApi().apply { contentResponse = contentResponse(bytes) },
            auth = auth,
            writer = writer,
        ).download(readyStatus(bytes), DESTINATION)

        assertEquals(
            AccountExportFailureKind.LOGIN_STATE,
            (outcome as AccountExportOutcome.Failure).kind,
        )
        assertFalse(writer.written)
        assertTrue(writer.discarded)
        assertEquals("user-b", auth.currentUserId)
    }

    @Test
    fun `account switch after a complete stream still discards the old account document`() = runTest {
        val bytes = "{\"account\":{\"status\":\"ACTIVE\"}}".encodeToByteArray()
        val auth = FakeGenerationAuth()
        val writer = FakeWriter(
            afterWrite = { auth.switchAccount("user-b", "session-b") },
        )

        val outcome = repository(
            FakeApi().apply { contentResponse = contentResponse(bytes) },
            auth = auth,
            writer = writer,
        ).download(readyStatus(bytes), DESTINATION)

        assertEquals(
            AccountExportFailureKind.LOGIN_STATE,
            (outcome as AccountExportOutcome.Failure).kind,
        )
        assertTrue(writer.written)
        assertTrue(writer.discarded)
        assertEquals("user-b", auth.currentUserId)
    }

    @Test
    fun `header mismatch never reaches the writer and discards the empty document`() = runTest {
        val bytes = "{\"account\":{}}".encodeToByteArray()
        val status = readyStatus(bytes)
        val badHeaders = validHeaders(bytes).newBuilder()
            .set("X-Content-SHA256", "0".repeat(64))
            .build()
        val api = FakeApi().apply {
            contentResponse = Response.success(
                bytes.toResponseBody("application/json; charset=utf-8".toMediaType()),
                badHeaders,
            )
        }
        val writer = FakeWriter()

        val outcome = repository(api, writer = writer).download(status, DESTINATION)

        assertEquals(
            AccountExportFailureKind.INVALID_RESPONSE,
            (outcome as AccountExportOutcome.Failure).kind,
        )
        assertFalse(writer.written)
        assertTrue(writer.discarded)
    }

    @Test(expected = CancellationException::class)
    fun `cancellation is rethrown and partial destination is discarded`() = runTest {
        val bytes = "{\"account\":{}}".encodeToByteArray()
        val writer = FakeWriter(writeCancellation = true)
        try {
            repository(
                FakeApi().apply { contentResponse = contentResponse(bytes) },
                writer = writer,
            ).download(readyStatus(bytes), DESTINATION)
        } finally {
            assertTrue(writer.discarded)
        }
    }

    @Test
    fun `logout deletion and account switch cancellation each discard an in-flight document`() = runTest {
        for (transition in listOf("logout", "delete-account", "account-switch")) {
            val bytes = "{\"transition\":\"$transition\"}".encodeToByteArray()
            val started = CompletableDeferred<Unit>()
            val writer = FakeWriter(blockAfterStart = started)
            val download = async {
                repository(
                    FakeApi().apply { contentResponse = contentResponse(bytes) },
                    writer = writer,
                ).download(readyStatus(bytes), DESTINATION)
            }

            started.await()
            download.cancelAndJoin()

            assertTrue("$transition must discard its partial document", writer.discarded)
        }
    }

    private fun repository(
        api: FakeApi,
        auth: FakeGenerationAuth = FakeGenerationAuth(),
        writer: FakeWriter = FakeWriter(),
    ) = AccountExportRepository(api, api, auth, writer, Unit)

    private fun readyStatus(bytes: ByteArray): AccountExportStatusResponse {
        val now = Instant.now()
        return AccountExportStatusResponse(
            exportId = ID,
            status = AccountExportStatus.READY,
            requestedAt = now.minusSeconds(60).toString(),
            expiresAt = now.plusSeconds(600).toString(),
            includeBehaviorHistory = true,
            downloadAvailable = true,
            readyAt = now.minusSeconds(30).toString(),
            sizeBytes = bytes.size.toLong(),
            sha256 = bytes.sha256(),
            contentType = "application/json",
        )
    }

    private fun contentResponse(bytes: ByteArray): Response<ResponseBody> = Response.success(
        bytes.toResponseBody("application/json; charset=utf-8".toMediaType()),
        validHeaders(bytes),
    )

    private fun validHeaders(bytes: ByteArray) = mapOf(
        "Content-Length" to bytes.size.toString(),
        "Content-Type" to "application/json; charset=utf-8",
        "X-Content-SHA256" to bytes.sha256(),
        "Digest" to "sha-256=${Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))}",
        "Content-Disposition" to "attachment; filename=\"chi-shen-me-account-export.json\"",
        "Cache-Control" to "private, no-store",
    ).toHeaders()

    private fun ByteArray.sha256(): String = MessageDigest.getInstance("SHA-256")
        .digest(this)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private class FakeGenerationAuth : GenerationAuthenticatedRequestExecutor {
        val invalidatedGenerations = mutableListOf<Long>()
        var currentGeneration = 17L
        var currentUserId: String? = "user-a"
        var currentSessionId: String? = "session-a"
        var afterCall: (() -> Unit)? = null

        override suspend fun <Value> execute(
            call: suspend (authorizationHeader: String) -> Value,
        ): AuthOutcome<AuthenticatedCallResult<Value>> {
            val capturedGeneration = currentGeneration
            val capturedUserId = requireNotNull(currentUserId)
            val capturedSessionId = requireNotNull(currentSessionId)
            val value = call("Bearer ephemeral")
            afterCall?.invoke()
            return AuthOutcome.Success(
                AuthenticatedCallResult(
                    value = value,
                    authenticationGeneration = capturedGeneration,
                    userId = capturedUserId,
                    sessionId = capturedSessionId,
                ),
            )
        }

        override suspend fun invalidateAuthentication(expectedGeneration: Long) {
            invalidatedGenerations += expectedGeneration
            if (currentGeneration == expectedGeneration) {
                currentGeneration += 1
                currentUserId = null
                currentSessionId = null
            }
        }

        override suspend fun isAuthenticationCurrent(
            expectedGeneration: Long,
            expectedUserId: String,
            expectedSessionId: String,
        ): Boolean = currentGeneration == expectedGeneration &&
            currentUserId == expectedUserId &&
            currentSessionId == expectedSessionId

        fun switchAccount(userId: String, sessionId: String) {
            currentGeneration += 1
            currentUserId = userId
            currentSessionId = sessionId
        }
    }

    private class FakeWriter(
        private val writeCancellation: Boolean = false,
        private val afterWrite: (() -> Unit)? = null,
        private val blockAfterStart: CompletableDeferred<Unit>? = null,
    ) : AccountExportDocumentWriter {
        var written = false
        var discarded = false
        var content = byteArrayOf()

        override fun supports(destinationUri: String): Boolean = destinationUri == DESTINATION

        override suspend fun write(
            destinationUri: String,
            input: InputStream,
            expectedSizeBytes: Long,
            expectedSha256: String,
        ): AccountExportWriteResult {
            written = true
            if (writeCancellation) throw CancellationException("stop")
            blockAfterStart?.let {
                it.complete(Unit)
                awaitCancellation()
            }
            val output = ByteArrayOutputStream()
            copyAndVerifyAccountExport(input, output, expectedSizeBytes, expectedSha256)
            content = output.toByteArray()
            afterWrite?.invoke()
            return AccountExportWriteResult.SUCCESS
        }

        override suspend fun discard(destinationUri: String) {
            discarded = true
        }
    }

    private class FakeApi : AccountExportApi, AccountExportContentApi {
        var authorization: String? = null
        var request: AccountExportRequest? = null
        var contentExportId: String? = null
        var latestResponse: Response<AccountExportLatestResponse> = Response.success(
            AccountExportLatestResponse(null),
        )
        var contentResponse: Response<ResponseBody> = Response.error(503, "ignored".toResponseBody())

        override suspend fun requestExport(
            authorization: String,
            request: AccountExportRequest,
        ): Response<AccountExportResponse> {
            this.authorization = authorization
            this.request = request
            val now = Instant.now()
            return Response.success(
                202,
                AccountExportResponse(
                    exportId = ID,
                    status = AccountExportStatus.QUEUED,
                    requestedAt = now.toString(),
                    expiresAt = now.plusSeconds(600).toString(),
                    includeBehaviorHistory = request.includeBehaviorHistory,
                ),
            )
        }

        override suspend fun latestExport(
            authorization: String,
        ): Response<AccountExportLatestResponse> {
            this.authorization = authorization
            return latestResponse
        }

        override suspend fun exportStatus(
            authorization: String,
            exportId: String,
        ): Response<AccountExportStatusResponse> = error("not used")

        override suspend fun exportContent(
            authorization: String,
            exportId: String,
        ): Response<ResponseBody> {
            this.authorization = authorization
            contentExportId = exportId
            return contentResponse
        }
    }

    private companion object {
        const val ID = "0192f014-7d64-4b59-8fc1-513465daae10"
        const val DESTINATION = "content://documents/export.json"
    }
}
