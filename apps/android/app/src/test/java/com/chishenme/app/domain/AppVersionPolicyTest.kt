package com.chishenme.app.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppVersionPolicyTest {
    @Test
    fun `release suffix does not make a compatible build older`() {
        assertFalse(AppVersionPolicy.isBelow("1.2.3-alpha01-debug", "1.2.3"))
        assertTrue(
            AppVersionPolicy.evaluate("1.2.3-alpha01", "1.2.3") is AppVersionStatus.Compatible,
        )
    }

    @Test
    fun `lower major minor or patch requires update`() {
        assertTrue(AppVersionPolicy.isBelow("0.9.9", "1.0.0"))
        assertTrue(AppVersionPolicy.isBelow("1.1.9", "1.2.0"))
        assertTrue(AppVersionPolicy.isBelow("1.2.2", "1.2.3"))
        assertEquals(
            AppVersionStatus.UpdateRequired("1.2.3"),
            AppVersionPolicy.evaluate("1.2.2", "1.2.3"),
        )
    }

    @Test
    fun `missing or malformed server version never claims compatibility`() {
        assertEquals(
            AppVersionStatus.ConfigurationUnavailable,
            AppVersionPolicy.evaluate("1.2.3", null),
        )
        assertEquals(
            AppVersionStatus.ConfigurationUnavailable,
            AppVersionPolicy.evaluate("1.2.3", "latest"),
        )
    }

    @Test
    fun `arbitrarily large numeric segments never overflow into zero`() {
        assertEquals(
            AppVersionStatus.UpdateRequired("999999999999999999999.0.0"),
            AppVersionPolicy.evaluate("1.0.0", "999999999999999999999.0.0"),
        )
        assertTrue(
            AppVersionPolicy.evaluate(
                "999999999999999999999.0.0-debug",
                "999999999999999999998.999999999999999999999.999999999999999999999",
            ) is AppVersionStatus.Compatible,
        )
    }
}
