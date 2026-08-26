package com.chishenme.app.auth.fusion

import javax.inject.Inject

/** Build-time fail-closed implementation for every variant without the pinned AAR. */
internal class PlatformFusionAuthSdkFactory @Inject constructor() : FusionAuthSdkFactory {
    override val available: Boolean = false

    override fun create(): FusionAuthSdk? = null
}
