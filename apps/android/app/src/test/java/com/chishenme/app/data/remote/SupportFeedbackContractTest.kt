package com.chishenme.app.data.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SupportFeedbackContractTest {
    @Test
    fun `message normalization and unicode length mirror the public contract`() {
        assertEquals("第一行\n第二行内容足够", SupportFeedbackContract.normalizeMessage("  第一行\r\n第二行内容足够  "))
        assertTrue(SupportFeedbackContract.isValidMessage("体验问题🙂🙂🙂🙂🙂🙂"))
        assertFalse(SupportFeedbackContract.isValidMessage("太短"))
        assertFalse(SupportFeedbackContract.isValidMessage("有效正文前\u0000后仍然足够长"))
        assertTrue(SupportFeedbackContract.isValidMessage("a".repeat(2_000)))
        assertFalse(SupportFeedbackContract.isValidMessage("a".repeat(2_001)))
    }

    @Test
    fun `ECMAScript trim set and draft cap stay cross platform safe`() {
        assertEquals(
            "有效正文长度已经足够",
            SupportFeedbackContract.normalizeMessage("\ufeff\u00a0有效正文长度已经足够\u3000"),
        )
        assertFalse(SupportFeedbackContract.isValidMessage("\u001c有效正文长度已经足够"))
        val limited = SupportFeedbackContract.limitDraft("🙂".repeat(2_201))
        assertEquals(2_200, limited.codePointCount(0, limited.length))
        assertFalse(limited.last().isHighSurrogate())
    }

    @Test
    fun `response must echo the exact normalized UUID and fixed retention`() {
        val id = "0192f014-7d64-4b59-8fc1-513465daae10"
        val valid = SupportFeedbackResponse(id, accepted = true, retentionAfterClosureDays = 180)

        assertTrue(SupportFeedbackContract.isUuidV4(id))
        assertTrue(SupportFeedbackContract.isValidResponse(valid, id.uppercase()))
        assertFalse(SupportFeedbackContract.isValidResponse(valid.copy(accepted = false), id))
        assertFalse(SupportFeedbackContract.isValidResponse(valid.copy(retentionAfterClosureDays = 179), id))
        assertFalse(
            SupportFeedbackContract.isValidResponse(
                valid.copy(feedbackId = "0192f014-7d64-4b59-8fc1-513465daae11"),
                id,
            ),
        )
    }
}
