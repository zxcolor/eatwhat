package com.chishenme.app.feature.results

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResultsScreenTextTest {
    @Test
    fun `alternative heading follows the actual candidate count`() {
        assertEquals("另一个靠谱选择", alternativeHeading(totalResultCount = 2))
        assertEquals("另外 2 个靠谱选择", alternativeHeading(totalResultCount = 3))
    }

    @Test
    fun `guest rules-only results have a persistent notice and no detail actions`() {
        val policy = recommendationResultsAccessPolicy(trustedCompatibleConfiguration = false)

        assertFalse(policy.detailActionsAvailable)
        assertEquals(GUEST_RULES_ONLY_NOTICE, policy.persistentNotice)
        assertTrue(requireNotNull(policy.persistentNotice).contains("按相同条件重新请求"))
        assertTrue(policy.persistentNotice.contains("结果可能相同"))
        assertFalse(policy.persistentNotice.contains("换一批"))
        assertTrue(policy.persistentNotice.contains("推荐事件均已关闭"))
    }

    @Test
    fun `same-condition retry copy does not promise different results`() {
        assertEquals("按相同条件重新请求，结果可能相同。", SAME_CONDITIONS_RETRY_DESCRIPTION)
        assertEquals("按相同条件重新请求", SAME_CONDITIONS_RETRY_ACTION)
        assertEquals("返回调整条件", ADJUST_CONDITIONS_ACTION)
        assertFalse(SAME_CONDITIONS_RETRY_DESCRIPTION.contains("反重复"))
    }

    @Test
    fun `trusted compatible results keep detail actions without degradation notice`() {
        val policy = recommendationResultsAccessPolicy(trustedCompatibleConfiguration = true)

        assertTrue(policy.detailActionsAvailable)
        assertNull(policy.persistentNotice)
    }
}
