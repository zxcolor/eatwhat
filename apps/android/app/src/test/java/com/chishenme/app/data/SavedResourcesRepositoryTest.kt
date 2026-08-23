package com.chishenme.app.data

import com.chishenme.app.data.remote.CreatePrivateFeedbackRequest
import com.chishenme.app.data.remote.FavoriteGroup
import com.chishenme.app.data.remote.FavoriteMutationRequest
import com.chishenme.app.data.remote.FavoriteRecord
import com.chishenme.app.data.remote.FavoritesPage
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PersistedPlacePresentation
import com.chishenme.app.data.remote.PersistedPresentationStatus
import com.chishenme.app.data.remote.PrivateFeedbackPage
import com.chishenme.app.data.remote.PrivateFeedbackRecord
import com.chishenme.app.data.remote.PrivateFeedbackType
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationHistoryAction
import com.chishenme.app.data.remote.RecommendationHistoryPage
import com.chishenme.app.data.remote.SavedResourcesApi
import com.chishenme.app.data.remote.UpdateFavoriteGroupRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class SavedResourcesRepositoryTest {
    @Test
    fun `favorite creation uses AuthRepository executor and minimal proof request`() = runTest {
        val api = FakeSavedResourcesApi()
        val auth = FakeAuthExecutor()
        val repository = repository(api, auth)
        val token = "A".repeat(43)

        val outcome = repository.createFavorite(
            requestId = REQUEST_ID,
            resultToken = token,
            group = FavoriteGroup.WANT_TO_GO,
        )

        assertTrue(outcome is SavedResourcesOutcome.Success)
        assertEquals("Bearer ephemeral-access", api.lastAuthorization)
        assertEquals(IDEMPOTENCY_KEY, api.lastFavoriteRequest?.idempotencyKey)
        assertEquals(REQUEST_ID, api.lastFavoriteRequest?.result?.requestId)
        assertEquals(token, api.lastFavoriteRequest?.result?.resultToken)
        assertEquals(FavoriteGroup.WANT_TO_GO, api.lastFavoriteRequest?.group)
    }

    @Test
    fun `malformed proof is rejected before bearer or network access`() = runTest {
        val api = FakeSavedResourcesApi()
        val auth = FakeAuthExecutor()
        val repository = repository(api, auth)

        val outcome = repository.createPrivateFeedback(
            requestId = REQUEST_ID,
            resultToken = "not-a-token",
            type = PrivateFeedbackType.LIKE,
        )

        assertEquals(SavedResourcesFailureKind.INPUT, (outcome as SavedResourcesOutcome.Failure).kind)
        assertEquals(0, auth.calls)
        assertEquals(0, api.calls)
    }

    @Test
    fun `401 403 409 and 429 have explicit safe classifications`() = runTest {
        val api = FakeSavedResourcesApi()
        val repository = repository(api, FakeAuthExecutor())
        val expected = mapOf(
            401 to SavedResourcesFailureKind.LOGIN_REQUIRED,
            403 to SavedResourcesFailureKind.RIGHTS_UNAVAILABLE,
            409 to SavedResourcesFailureKind.CONFLICT,
            429 to SavedResourcesFailureKind.RATE_LIMITED,
        )

        expected.forEach { (code, kind) ->
            api.createFavoriteResponse = Response.error(code, "ignored".toResponseBody())
            val outcome = repository.createFavorite(REQUEST_ID, "A".repeat(43), FavoriteGroup.REGULAR)
            val failure = outcome as SavedResourcesOutcome.Failure
            assertEquals(kind, failure.kind)
            assertFalse(failure.message.contains("Bearer"))
            assertFalse(failure.message.contains("A".repeat(43)))
        }
    }

    @Test
    fun `contract mismatch from authenticated executor remains distinct`() = runTest {
        val api = FakeSavedResourcesApi()
        val auth = FakeAuthExecutor(
            failure = AuthOutcome.Failure(AuthFailureKind.INCOMPATIBLE_API, "untrusted detail"),
        )

        val outcome = repository(api, auth).listFavorites()

        val failure = outcome as SavedResourcesOutcome.Failure
        assertEquals(SavedResourcesFailureKind.INCOMPATIBLE_API, failure.kind)
        assertFalse(failure.message.contains("untrusted"))
        assertEquals(0, api.calls)
    }

    @Test(expected = CancellationException::class)
    fun `cancellation is rethrown and never mapped to a UI failure`() = runTest {
        val auth = object : AuthenticatedRequestExecutor {
            override suspend fun <Value> executeAuthenticated(
                call: suspend (authorizationHeader: String) -> Value,
            ): AuthOutcome<Value> = throw CancellationException("stop")
        }
        repository(FakeSavedResourcesApi(), auth).listFavorites()
    }

    private fun repository(
        api: SavedResourcesApi,
        auth: AuthenticatedRequestExecutor,
    ) = SavedResourcesRepository(api, auth, { IDEMPOTENCY_KEY }, Unit)

    private class FakeAuthExecutor(
        private val failure: AuthOutcome.Failure? = null,
    ) : AuthenticatedRequestExecutor {
        var calls = 0
        override suspend fun <Value> executeAuthenticated(
            call: suspend (authorizationHeader: String) -> Value,
        ): AuthOutcome<Value> {
            calls += 1
            failure?.let { return it }
            return AuthOutcome.Success(call("Bearer ephemeral-access"))
        }
    }

    private class FakeSavedResourcesApi : SavedResourcesApi {
        var calls = 0
        var lastAuthorization: String? = null
        var lastFavoriteRequest: FavoriteMutationRequest? = null
        var createFavoriteResponse: Response<FavoriteRecord> = Response.success(201, favorite())

        override suspend fun listFavorites(
            authorization: String,
            cursor: String?,
            limit: String,
            group: FavoriteGroup?,
        ): Response<FavoritesPage> {
            called(authorization)
            return Response.success(FavoritesPage(emptyList(), null))
        }

        override suspend fun createFavorite(
            authorization: String,
            request: FavoriteMutationRequest,
        ): Response<FavoriteRecord> {
            called(authorization)
            lastFavoriteRequest = request
            return createFavoriteResponse
        }

        override suspend fun updateFavoriteGroup(
            authorization: String,
            favoriteId: String,
            request: UpdateFavoriteGroupRequest,
        ): Response<FavoriteRecord> {
            called(authorization)
            return Response.success(favorite().copy(group = request.group))
        }

        override suspend fun deleteFavorite(
            authorization: String,
            favoriteId: String,
        ): Response<Unit> {
            called(authorization)
            return Response.success(204, Unit)
        }

        override suspend fun listHistory(
            authorization: String,
            cursor: String?,
            limit: String,
            action: RecommendationHistoryAction?,
        ): Response<RecommendationHistoryPage> {
            called(authorization)
            return Response.success(RecommendationHistoryPage(emptyList(), null, 90))
        }

        override suspend fun clearHistory(authorization: String): Response<Unit> {
            called(authorization)
            return Response.success(204, Unit)
        }

        override suspend fun listPrivateFeedback(
            authorization: String,
            cursor: String?,
            limit: String,
            type: PrivateFeedbackType?,
        ): Response<PrivateFeedbackPage> {
            called(authorization)
            return Response.success(PrivateFeedbackPage(emptyList(), null))
        }

        override suspend fun createPrivateFeedback(
            authorization: String,
            request: CreatePrivateFeedbackRequest,
        ): Response<PrivateFeedbackRecord> {
            called(authorization)
            return Response.success(
                201,
                PrivateFeedbackRecord(
                    feedbackId = "22222222-2222-4222-8222-222222222222",
                    type = request.type,
                    visibility = "PRIVATE",
                    createdAt = NOW,
                    presentation = available(),
                ),
            )
        }

        override suspend fun deletePrivateFeedback(
            authorization: String,
            feedbackId: String,
        ): Response<Unit> {
            called(authorization)
            return Response.success(204, Unit)
        }

        override suspend fun clearPrivateFeedback(authorization: String): Response<Unit> {
            called(authorization)
            return Response.success(204, Unit)
        }

        private fun called(authorization: String) {
            calls += 1
            lastAuthorization = authorization
        }
    }

    private companion object {
        const val REQUEST_ID = "11111111-1111-4111-8111-111111111111"
        const val IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333"
        const val NOW = "2026-08-21T00:00:00Z"

        fun favorite() = FavoriteRecord(
            favoriteId = "44444444-4444-4444-8444-444444444444",
            group = FavoriteGroup.WANT_TO_GO,
            createdAt = NOW,
            presentation = available(),
        )

        fun available() = PersistedPlacePresentation(
            presentationStatus = PersistedPresentationStatus.AVAILABLE,
            name = "学院路面馆",
            address = "海淀区学院路 25 号",
            sourceLabel = "经授权餐厅数据",
            dataMode = RecommendationDataMode.LIVE,
            openStatus = OpenStatus.OPEN,
            averageCostYuan = 25.0,
            tags = listOf("面食"),
            resolvedAt = NOW,
        )
    }
}
