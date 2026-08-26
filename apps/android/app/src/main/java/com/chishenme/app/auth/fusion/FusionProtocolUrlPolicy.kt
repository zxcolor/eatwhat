package com.chishenme.app.auth.fusion

import java.net.URI
import java.util.Locale

/** Exact carrier-agreement hosts published by the pinned SDK's Constant class. */
internal object FusionProtocolUrlPolicy {
    private val allowedHosts = setOf(
        "wap.cmpassport.com",
        "opencloud.wostore.cn",
        "msv6.wosms.cn",
        "e.189.cn",
    )

    fun isAllowed(rawUrl: String?): Boolean {
        val candidate = rawUrl?.takeIf { it.length in 1..2_048 } ?: return false
        val uri = runCatching { URI(candidate) }.getOrNull() ?: return false
        val host = uri.host?.lowercase(Locale.ROOT) ?: return false
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.rawUserInfo == null &&
            uri.port in setOf(-1, 443) &&
            host in allowedHosts
    }
}
