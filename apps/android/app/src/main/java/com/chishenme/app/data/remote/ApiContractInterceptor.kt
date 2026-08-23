package com.chishenme.app.data.remote

import java.io.IOException
import java.util.Collections
import java.util.IdentityHashMap
import okhttp3.Interceptor
import okhttp3.Response

const val API_CONTRACT_VERSION_HEADER = "X-ChiShenMe-Contract-Version"
const val API_CONTRACT_VERSION = "1"

/**
 * Signals that the server did not confirm the one contract version this client understands.
 *
 * The exception deliberately accepts no server-provided values so its message is safe to show
 * in diagnostics without exposing response metadata, request URLs or bodies.
 */
class IncompatibleApiContractException : IOException(
    "API contract version is incompatible",
)

/**
 * Recognizes a compatibility failure even when a networking layer wraps the original
 * [IncompatibleApiContractException]. The walk is deliberately finite and identity-based:
 * malformed cyclic cause chains cannot hang the app, and no exception message or transport
 * metadata is inspected or copied into a user-visible result.
 */
internal fun Throwable.hasIncompatibleApiContractCause(): Boolean {
    val visited = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
    var current: Throwable? = this

    repeat(MAX_COMPATIBILITY_CAUSE_DEPTH) {
        val error = current ?: return false
        if (!visited.add(error)) return false
        if (error is IncompatibleApiContractException) return true
        current = try {
            error.cause
        } catch (_: Throwable) {
            return false
        }
    }
    return false
}

private const val MAX_COMPATIBILITY_CAUSE_DEPTH = 8

class ApiContractInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .header(API_CONTRACT_VERSION_HEADER, API_CONTRACT_VERSION)
            .build()
        val response = chain.proceed(request)
        val versions = response.headers.values(API_CONTRACT_VERSION_HEADER)

        if (versions.size == 1 && versions.single() == API_CONTRACT_VERSION) {
            return response
        }
        // A reverse proxy cannot emit the application-owned contract header when
        // its upstream is unavailable. Preserve only the three standard gateway
        // outage responses so Retrofit can classify them as service failures.
        // Any header value (including an empty, duplicate or future value) remains
        // authoritative and must pass the exact-version rule above.
        if (versions.isEmpty() && response.code in GATEWAY_OUTAGE_STATUS_CODES) {
            return response
        }

        try {
            response.close()
        } catch (_: Exception) {
            // Compatibility failure remains the actionable error. Never surface response details.
        }
        throw IncompatibleApiContractException()
    }
}

private val GATEWAY_OUTAGE_STATUS_CODES = setOf(502, 503, 504)
