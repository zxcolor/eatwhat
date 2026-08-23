package com.chishenme.app.data.remote

import java.io.IOException
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ApiContractInterceptorTest {
    @Test
    fun `compatibility cause detector accepts bounded wrapping and rejects excessive depth`() {
        val withinLimit = wrap(
            count = 7,
            terminal = IncompatibleApiContractException(),
        )
        val beyondLimit = wrap(
            count = 8,
            terminal = IncompatibleApiContractException(),
        )

        assertTrue(withinLimit.hasIncompatibleApiContractCause())
        assertFalse(beyondLimit.hasIncompatibleApiContractCause())
    }

    @Test
    fun `compatibility cause detector terminates on a cyclic chain`() {
        val first = MutableCauseIOException()
        val second = MutableCauseIOException()
        first.next = second
        second.next = first

        assertFalse(first.hasIncompatibleApiContractCause())
    }

    @Test
    fun `adds exactly one client contract header and accepts exact server version`() {
        var capturedRequest: Request? = null
        val client = clientWithTerminalResponse(
            responseHeaders = listOf(API_CONTRACT_VERSION),
            onRequest = { capturedRequest = it },
        )
        val request = Request.Builder()
            .url("https://not-used.invalid/")
            .addHeader(API_CONTRACT_VERSION_HEADER, "legacy-client-value")
            .build()

        client.newCall(request).execute().use { response ->
            assertEquals(200, response.code)
        }

        assertEquals(
            listOf(API_CONTRACT_VERSION),
            capturedRequest?.headers?.values(API_CONTRACT_VERSION_HEADER),
        )
    }

    @Test
    fun `missing server contract header closes response and throws dedicated exception`() {
        val responseBody = TrackingResponseBody("response-private-value")
        val client = clientWithTerminalResponse(responseBody = responseBody)

        val error = expectIncompatibleContract(client, "https://not-used.invalid/missing")

        assertTrue(responseBody.closed)
        assertEquals("API contract version is incompatible", error.message)
    }

    @Test
    fun `missing contract header is preserved only for gateway outage responses`() {
        listOf(502, 503, 504).forEach { responseCode ->
            val responseBody = TrackingResponseBody("gateway-generated-body")
            val client = clientWithTerminalResponse(
                responseCode = responseCode,
                responseBody = responseBody,
            )

            client.newCall(
                Request.Builder().url("https://not-used.invalid/gateway-$responseCode").build(),
            ).execute().use { response ->
                assertEquals(responseCode, response.code)
                assertFalse(responseBody.closed)
            }

            assertTrue(responseBody.closed)
        }
    }

    @Test
    fun `missing contract header on non-gateway server failure is still rejected`() {
        val responseBody = TrackingResponseBody("server-generated-body")
        val client = clientWithTerminalResponse(
            responseCode = 500,
            responseBody = responseBody,
        )

        expectIncompatibleContract(client, "https://not-used.invalid/server-500")

        assertTrue(responseBody.closed)
    }

    @Test
    fun `gateway response with any explicit invalid contract header is rejected`() {
        listOf(
            listOf("future"),
            listOf(API_CONTRACT_VERSION, API_CONTRACT_VERSION),
            listOf(API_CONTRACT_VERSION, "future"),
            listOf(""),
        ).forEachIndexed { index, headers ->
            val responseBody = TrackingResponseBody("gateway-generated-body")
            val client = clientWithTerminalResponse(
                responseCode = 503,
                responseHeaders = headers,
                responseBody = responseBody,
            )

            expectIncompatibleContract(client, "https://not-used.invalid/gateway-header-$index")

            assertTrue(responseBody.closed)
        }
    }

    @Test
    fun `mismatched server contract header closes response without leaking metadata`() {
        val rawHeader = "server-secret-version"
        val privateUrlPart = "private-location"
        val privateBody = "body-result-token-and-coordinates"
        val responseBody = TrackingResponseBody(privateBody)
        val client = clientWithTerminalResponse(
            responseHeaders = listOf(rawHeader),
            responseBody = responseBody,
        )

        val error = expectIncompatibleContract(
            client,
            "https://not-used.invalid/$privateUrlPart",
        )
        val safeMessage = error.message.orEmpty()

        assertTrue(responseBody.closed)
        assertFalse(safeMessage.contains(rawHeader))
        assertFalse(safeMessage.contains(privateUrlPart))
        assertFalse(safeMessage.contains(privateBody))
    }

    @Test
    fun `multiple server contract headers are rejected even when one is supported`() {
        val responseBody = TrackingResponseBody("{}")
        val client = clientWithTerminalResponse(
            responseHeaders = listOf(API_CONTRACT_VERSION, "future"),
            responseBody = responseBody,
        )

        expectIncompatibleContract(client, "https://not-used.invalid/multiple")

        assertTrue(responseBody.closed)
    }

    private fun clientWithTerminalResponse(
        responseCode: Int = 200,
        responseHeaders: List<String> = emptyList(),
        responseBody: ResponseBody = TrackingResponseBody("{}"),
        onRequest: (Request) -> Unit = {},
    ): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(ApiContractInterceptor())
        .addInterceptor(
            Interceptor { chain ->
                onRequest(chain.request())
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(responseCode)
                    .message("fixture-$responseCode")
                    .body(responseBody)
                    .apply {
                        responseHeaders.forEach { value ->
                            addHeader(API_CONTRACT_VERSION_HEADER, value)
                        }
                    }
                    .build()
            },
        )
        .build()

    private fun expectIncompatibleContract(
        client: OkHttpClient,
        url: String,
    ): IncompatibleApiContractException {
        try {
            client.newCall(Request.Builder().url(url).build()).execute()
            fail("Incompatible API response must be rejected")
        } catch (error: IncompatibleApiContractException) {
            return error
        } catch (error: IOException) {
            fail("Expected dedicated exception but got ${error::class.java.simpleName}")
        }
        error("unreachable")
    }

    private fun wrap(count: Int, terminal: Throwable): Throwable =
        (0 until count).fold(terminal) { cause, _ -> IOException(null, cause) }

    private class MutableCauseIOException : IOException() {
        var next: Throwable? = null
        override val cause: Throwable?
            get() = next
    }

    private class TrackingResponseBody(content: String) : ResponseBody() {
        var closed: Boolean = false
            private set

        private val trackingSource = object : ForwardingSource(Buffer().writeUtf8(content)) {
            override fun close() {
                closed = true
                super.close()
            }
        }.buffer()

        override fun contentType(): MediaType? = null

        override fun contentLength(): Long = -1L

        override fun source(): BufferedSource = trackingSource
    }
}
