package com.chishenme.app.data

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AccountExportDocumentWriterTest {
    @Test
    fun `streaming copy accepts exact length and SHA256 without buffering the artifact`() {
        val content = "{\"account\":{\"status\":\"ACTIVE\"}}".encodeToByteArray()
        val destination = ByteArrayOutputStream()

        copyAndVerifyAccountExport(
            input = ByteArrayInputStream(content),
            output = destination,
            expectedSizeBytes = content.size.toLong(),
            expectedSha256 = content.sha256(),
        )

        assertArrayEquals(content, destination.toByteArray())
    }

    @Test(expected = InvalidAccountExportContent::class)
    fun `checksum mismatch is rejected after the streamed copy`() {
        val content = "{\"account\":{}}".encodeToByteArray()
        copyAndVerifyAccountExport(
            input = ByteArrayInputStream(content),
            output = ByteArrayOutputStream(),
            expectedSizeBytes = content.size.toLong(),
            expectedSha256 = "0".repeat(64),
        )
    }

    @Test(expected = InvalidAccountExportContent::class)
    fun `content longer than declared length fails before writing the excess chunk`() {
        val content = ByteArray(65_537) { 1 }
        copyAndVerifyAccountExport(
            input = ByteArrayInputStream(content),
            output = ByteArrayOutputStream(),
            expectedSizeBytes = 1,
            expectedSha256 = content.sha256(),
        )
    }

    @Test
    fun `copy buffer is zeroed in finally after verification failure`() {
        val content = "sensitive-account-export".encodeToByteArray()
        val input = CapturingInputStream(content)

        try {
            copyAndVerifyAccountExport(
                input = input,
                output = ByteArrayOutputStream(),
                expectedSizeBytes = content.size.toLong(),
                expectedSha256 = "0".repeat(64),
            )
            fail("checksum mismatch should fail")
        } catch (_: InvalidAccountExportContent) {
            // Expected: the assertion below verifies the finally cleanup path.
        }

        val copyBuffer = requireNotNull(input.copyBuffer)
        assertTrue(copyBuffer.all { byte -> byte == 0.toByte() })
    }

    private fun ByteArray.sha256(): String = MessageDigest.getInstance("SHA-256")
        .digest(this)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private class CapturingInputStream(
        private val content: ByteArray,
    ) : InputStream() {
        var copyBuffer: ByteArray? = null
            private set
        private var position = 0

        override fun read(): Int {
            if (position >= content.size) return -1
            return content[position++].toInt() and 0xff
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            copyBuffer = buffer
            if (position >= content.size) return -1
            val count = minOf(length, content.size - position)
            content.copyInto(buffer, offset, position, position + count)
            position += count
            return count
        }
    }
}
