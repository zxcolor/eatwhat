package com.chishenme.app.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class AuthHttpFailureMappingTest {
    @Test
    fun `verified unbound identity code maps to fixed provider-neutral guidance`() {
        val upstreamMessage = "untrusted upstream text must never reach the UI"
        val failure = mapAuthHttpFailure(
            httpError(
                """{
                    "requestId":"11111111-1111-4111-8111-111111111111",
                    "code":"IDENTITY_NOT_BOUND",
                    "message":"$upstreamMessage"
                }""".trimIndent(),
            ),
        )

        assertEquals(AuthFailureKind.UNAUTHORIZED, failure.kind)
        assertEquals("该登录身份尚未绑定账号，请先用手机号登录后完成绑定", failure.message)
        assertFalse(failure.message.contains(upstreamMessage))
    }

    @Test
    fun `malformed unknown or oversized 401 bodies stay on the generic failure path`() {
        val genericMessage = "验证码、授权或登录状态无效"
        val bodies = listOf(
            "not-json",
            """{
                "requestId":"not-a-uuid",
                "code":"IDENTITY_NOT_BOUND",
                "message":"ignored"
            }""".trimIndent(),
            """{
                "requestId":"11111111-1111-4111-8111-111111111111",
                "code":"UNKNOWN_CODE",
                "message":"ignored"
            }""".trimIndent(),
            """{
                "requestId":"11111111-1111-4111-8111-111111111111",
                "code":"IDENTITY_NOT_BOUND",
                "message":"ignored",
                "unexpected":true
            }""".trimIndent(),
            "x".repeat(4 * 1_024 + 1),
        )

        bodies.forEach { body ->
            assertEquals(genericMessage, mapAuthHttpFailure(httpError(body)).message)
        }
    }

    private fun httpError(body: String): HttpException = HttpException(
        Response.error<Any>(
            401,
            body.toResponseBody("application/json; charset=utf-8".toMediaType()),
        ),
    )
}
