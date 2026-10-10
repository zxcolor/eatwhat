package com.chishenme.app.feature.account

import org.junit.Assert.assertEquals
import org.junit.Test

class AccountSessionPresentationTest {
    @Test
    fun `cross platform sessions retain an accurate user facing platform name`() {
        assertEquals("Android", sessionPlatformLabel("ANDROID"))
        assertEquals("微信小程序", sessionPlatformLabel("MINIPROGRAM"))
        assertEquals("未知平台", sessionPlatformLabel("UNKNOWN"))
    }
}
