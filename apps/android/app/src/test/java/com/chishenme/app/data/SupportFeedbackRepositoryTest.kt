package com.chishenme.app.data

import com.chishenme.app.data.remote.SupportFeedbackApi
import com.chishenme.app.data.remote.SupportFeedbackCategory
import com.chishenme.app.data.remote.SupportFeedbackRequest
import com.chishenme.app.data.remote.SupportFeedbackResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class SupportFeedbackRepositoryTest {
    @Test
    fun `true guest sends no bearer and receives only the fixed receipt`() = runTest {
        val api = FakeSupportFeedbackApi()
        val auth = FakeOptionalAuthExecutor(header = null)
        val repository = SupportFeedbackRepository(api, auth, Unit)

        val outcome = repository.submit(
            ID,
            SupportFeedbackCategory.PRODUCT,
            "  页面按钮无法正常使用  ",
            forceGuest = false,
        )

        assertTrue(outcome is SupportFeedbackOutcome.Success)
        assertNull(api.authorization)
        assertEquals(ID, api.request?.submissionId)
        assertEquals("页面按钮无法正常使用", api.request?.message)
        assertEquals(180, (outcome as SupportFeedbackOutcome.Success).value.retentionAfterClosureDays)
    }

    @Test
    fun `unrestorable local session never reaches network as guest`() = runTest {
        val api = FakeSupportFeedbackApi()
        val auth = FakeOptionalAuthExecutor(
            failure = AuthOutcome.Failure(AuthFailureKind.UNAUTHORIZED, "untrusted token detail"),
        )

        val outcome = SupportFeedbackRepository(api, auth, Unit).submit(
            ID,
            SupportFeedbackCategory.PRIVACY,
            "本机登录状态已经失效无法验证",
            forceGuest = false,
        )

        val failure = outcome as SupportFeedbackOutcome.Failure
        assertEquals(SupportFeedbackFailureKind.LOGIN_STATE, failure.kind)
        assertEquals(0, api.calls)
        assertFalse(failure.message.contains("untrusted"))
        assertTrue(failure.message.contains("降级"))
        assertTrue(failure.message.contains("游客"))
    }

    @Test
    fun `authenticated 401 clears local authentication and does not retry`() = runTest {
        val api = FakeSupportFeedbackApi().apply {
            response = Response.error(401, "ignored".toResponseBody())
        }
        val auth = FakeOptionalAuthExecutor(header = "Bearer ephemeral")

        val outcome = SupportFeedbackRepository(api, auth, Unit).submit(
            ID,
            SupportFeedbackCategory.COMPLAINT,
            "希望处理当前账号相关的投诉问题",
            forceGuest = false,
        )

        assertEquals(SupportFeedbackFailureKind.LOGIN_STATE, (outcome as SupportFeedbackOutcome.Failure).kind)
        assertEquals(1, api.calls)
        assertEquals(1, auth.invalidations)
    }

    @Test
    fun `guest 401 cannot clear a session created after the request began`() = runTest {
        val api = FakeSupportFeedbackApi().apply {
            response = Response.error(401, "ignored".toResponseBody())
        }
        val auth = FakeOptionalAuthExecutor(header = null)

        val outcome = SupportFeedbackRepository(api, auth, Unit).submit(
            ID,
            SupportFeedbackCategory.PRODUCT,
            "游客请求不应清理随后建立的登录状态",
            forceGuest = false,
        )

        assertEquals(
            SupportFeedbackFailureKind.INCOMPATIBLE_API,
            (outcome as SupportFeedbackOutcome.Failure).kind,
        )
        assertEquals(0, auth.invalidations)
    }

    @Test
    fun `malformed receipt is never presented as accepted`() = runTest {
        val api = FakeSupportFeedbackApi().apply {
            response = Response.success(
                202,
                SupportFeedbackResponse(
                    feedbackId = "0192f014-7d64-4b59-8fc1-513465daae11",
                    accepted = true,
                    retentionAfterClosureDays = 180,
                ),
            )
        }

        val outcome = SupportFeedbackRepository(api, FakeOptionalAuthExecutor(null), Unit).submit(
            ID,
            SupportFeedbackCategory.PLACE_CORRECTION,
            "这家餐厅的营业时间信息需要纠正",
            forceGuest = false,
        )

        assertEquals(
            SupportFeedbackFailureKind.INVALID_RESPONSE,
            (outcome as SupportFeedbackOutcome.Failure).kind,
        )
    }

    @Test(expected = CancellationException::class)
    fun `cancellation is never converted into a feedback error`() = runTest {
        val auth = object : OptionalAuthenticatedRequestExecutor {
            override suspend fun <Value> execute(
                forceGuest: Boolean,
                call: suspend (authorizationHeader: String?) -> Value,
            ): AuthOutcome<OptionalAuthenticatedCallResult<Value>> = throw CancellationException("stop")
        }
        SupportFeedbackRepository(FakeSupportFeedbackApi(), auth, Unit).submit(
            ID,
            SupportFeedbackCategory.PRODUCT,
            "这个反馈会在取消前保持内存状态",
            forceGuest = false,
        )
    }

    private class FakeOptionalAuthExecutor(
        private val header: String? = null,
        private val failure: AuthOutcome.Failure? = null,
    ) : OptionalAuthenticatedRequestExecutor {
        var invalidations = 0

        override suspend fun <Value> execute(
            forceGuest: Boolean,
            call: suspend (authorizationHeader: String?) -> Value,
        ): AuthOutcome<OptionalAuthenticatedCallResult<Value>> = failure ?: AuthOutcome.Success(
            OptionalAuthenticatedCallResult(
                value = call(if (forceGuest) null else header),
                authenticationGeneration = if (!forceGuest && header != null) 7L else null,
            ),
        )

        override suspend fun invalidateAuthentication(expectedGeneration: Long) {
            assertEquals(7L, expectedGeneration)
            invalidations += 1
        }
    }

    private class FakeSupportFeedbackApi : SupportFeedbackApi {
        var calls = 0
        var authorization: String? = null
        var request: SupportFeedbackRequest? = null
        var response: Response<SupportFeedbackResponse> = Response.success(
            202,
            SupportFeedbackResponse(ID, accepted = true, retentionAfterClosureDays = 180),
        )

        override suspend fun submit(
            authorization: String?,
            request: SupportFeedbackRequest,
        ): Response<SupportFeedbackResponse> {
            calls += 1
            this.authorization = authorization
            this.request = request
            return response
        }
    }

    private companion object {
        const val ID = "0192f014-7d64-4b59-8fc1-513465daae10"
    }
}
