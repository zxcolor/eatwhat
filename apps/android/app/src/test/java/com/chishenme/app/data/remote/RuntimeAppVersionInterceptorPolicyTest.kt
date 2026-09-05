package com.chishenme.app.data.remote

import com.chishenme.app.feature.config.RuntimeAppVersionGate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeAppVersionInterceptorPolicyTest {
    @Test
    fun `unknown loading allows only config and local account safety paths`() {
        val gate = RuntimeAppVersionGate("1.0.0").apply {
            markConfigurationUntrusted(1)
        }

        assertTrue(runtimeRequestAllowed("GET", "/v1/config", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/config", gate.currentState))
        assertTrue(runtimeRequestAllowed("POST", "/v1/auth/refresh", gate.currentState))
        assertFalse(runtimeRequestAllowed("GET", "/v1/auth/refresh", gate.currentState))
        assertTrue(runtimeRequestAllowed("POST", "/v1/auth/logout", gate.currentState))
        assertFalse(runtimeRequestAllowed("GET", "/v1/auth/logout", gate.currentState))
        assertTrue(runtimeRequestAllowed("DELETE", "/v1/account", gate.currentState))
        assertFalse(runtimeRequestAllowed("GET", "/v1/account", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/account", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/recommendations", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/group-recommendations", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/unsupported-write", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/support-feedback", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/auth/login", gate.currentState))
        assertFalse(runtimeRequestAllowed("GET", "/v1/auth/identities", gate.currentState))
        assertFalse(runtimeRequestAllowed("GET", "/v1/account/export", gate.currentState))
    }

    @Test
    fun `guest fallback adds recommendation only while update required adds nothing`() {
        val gate = RuntimeAppVersionGate("1.0.0")
        gate.markConfigurationUntrusted(1)
        gate.markConfigurationUnavailable(1)
        assertTrue(runtimeRequestAllowed("POST", "/v1/recommendations", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/group-recommendations", gate.currentState))
        assertFalse(runtimeRequestAllowed("GET", "/v1/recommendations", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/unsupported-write", gate.currentState))

        gate.markConfigurationUntrusted(2)
        gate.acceptTrustedConfiguration(2, "2.0.0")
        assertFalse(runtimeRequestAllowed("POST", "/v1/recommendations", gate.currentState))
        assertFalse(runtimeRequestAllowed("POST", "/v1/auth/login", gate.currentState))
        assertTrue(runtimeRequestAllowed("GET", "/v1/config", gate.currentState))
    }

    @Test
    fun `group route is available only under trusted compatible remote access`() {
        val gate = RuntimeAppVersionGate("1.0.0")
        gate.markConfigurationUntrusted(1)
        gate.acceptTrustedConfiguration(1, "1.0.0")

        assertTrue(runtimeRequestAllowed("POST", "/v1/group-recommendations", gate.currentState))

        gate.markConfigurationUntrusted(2)
        gate.markConfigurationUnavailable(2)

        assertFalse(runtimeRequestAllowed("POST", "/v1/group-recommendations", gate.currentState))
        assertTrue(runtimeRequestAllowed("POST", "/v1/recommendations", gate.currentState))
    }
}
