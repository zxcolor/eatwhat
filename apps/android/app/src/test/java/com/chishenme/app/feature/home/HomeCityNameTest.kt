package com.chishenme.app.feature.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HomeCityNameTest {
    @Test
    fun `municipality takes precedence over a reported district`() {
        assertEquals("北京市", homeCityName("丰台区", "北京市"))
        assertEquals("上海", homeCityName("黄浦区", "上海"))
    }

    @Test
    fun `normal city excludes province and address`() {
        assertEquals("杭州市", homeCityName("  杭州市  ", "浙江省"))
        assertEquals("San Francisco", homeCityName("San Francisco", "California"))
    }

    @Test
    fun `province alone does not masquerade as a city`() {
        assertNull(homeCityName(null, "浙江省"))
        assertNull(homeCityName("  ", null))
    }
}
