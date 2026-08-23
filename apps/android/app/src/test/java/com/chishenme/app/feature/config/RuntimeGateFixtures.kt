package com.chishenme.app.feature.config

internal fun compatibleRuntimeAppVersionGate(
    generation: Long = 1,
): RuntimeAppVersionGate = RuntimeAppVersionGate("0.1.0").apply {
    markConfigurationUntrusted(generation)
    acceptTrustedConfiguration(generation, "0.1.0")
}
