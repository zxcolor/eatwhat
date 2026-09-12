package com.chishenme.app.data.remote

import com.chishenme.app.feature.config.RuntimeAppVersionGate
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import okhttp3.Interceptor
import okhttp3.Response

private const val FEATURE_CONFIG_PATH = "/v1/config"
private const val RECOMMENDATION_PATH = "/v1/recommendations"
private val LOCAL_SAFETY_REQUESTS = setOf(
    "POST" to "/v1/auth/refresh",
    "POST" to "/v1/auth/logout",
    "DELETE" to "/v1/account",
)

internal fun runtimeRequestAllowed(
    method: String,
    path: String,
    state: RuntimeAppVersionGate.State,
): Boolean {
    // Retirement is permanent, even when an older server advertises the capability.
    if (path.trimEnd('/') == "/v1/group-recommendations") return false
    return (method == "GET" && path == FEATURE_CONFIG_PATH) ||
        (method to path) in LOCAL_SAFETY_REQUESTS ||
        state.remoteFeaturesAllowed ||
        (method == "POST" &&
            path == RECOMMENDATION_PATH &&
            state.failClosedGuestDecisionAllowed)
}

/**
 * Defense-in-depth: without a current compatible gate, only config rechecks,
 * exact data-rights safety requests and the explicit guest fallback are allowed.
 */
@Singleton
class RuntimeAppVersionInterceptor @Inject constructor(
    private val gate: RuntimeAppVersionGate,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!runtimeRequestAllowed(request.method, request.url.encodedPath, gate.currentState)) {
            throw IOException("远程能力尚未通过当前版本兼容性校验")
        }
        return chain.proceed(request)
    }
}
