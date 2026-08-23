package com.chishenme.app.feature.saved

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import com.chishenme.app.data.AuthOutcome
import com.chishenme.app.data.AuthRepository
import com.chishenme.app.data.AuthenticatedRequestExecutor
import com.chishenme.app.data.SavedResourcesRepository
import com.chishenme.app.data.local.AuthSessionStore
import com.chishenme.app.data.local.AuthSessionToPersist
import com.chishenme.app.data.local.RefreshTokenCipher
import com.chishenme.app.data.remote.AuthApi
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.AuthTokenResponse
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.CreatePrivateFeedbackRequest
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FavoriteGroup
import com.chishenme.app.data.remote.FavoriteMutationRequest
import com.chishenme.app.data.remote.FavoriteRecord
import com.chishenme.app.data.remote.FavoritesPage
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PersistedPlacePresentation
import com.chishenme.app.data.remote.PersistedPresentationStatus
import com.chishenme.app.data.remote.PersistenceCapabilities
import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchResponse
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.data.remote.PrivateFeedbackPage
import com.chishenme.app.data.remote.PrivateFeedbackRecord
import com.chishenme.app.data.remote.PrivateFeedbackType
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationHistoryAction
import com.chishenme.app.data.remote.RecommendationHistoryPage
import com.chishenme.app.data.remote.SavedResourcesApi
import com.chishenme.app.data.remote.UpdateFavoriteGroupRequest
import java.lang.reflect.Proxy
import java.time.Instant
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class SavedResourcesCapabilityRefreshLifecycleTest {
    @Test
    fun `runtime gate refresh revokes resources and discards a late page`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val api = ControlledSavedResourcesApi().apply { blockNextFavoritesPage = true }
        try {
            val gate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate()
            val viewModel = viewModel(api, gate)
            runCurrent()
            viewModel.start(enabledConfig(), configurationGeneration = 1)
            runCurrent()
            assertTrue(api.favoritesPageStarted.isCompleted)

            gate.markConfigurationUntrusted(2)
            runCurrent()
            assertTrue(viewModel.state.value.enabledSections.isEmpty())
            assertTrue(viewModel.state.value.favorites.isEmpty())

            api.releaseFavoritesPage(FavoritesPage(listOf(favorite(LATE_FAVORITE_ID)), null))
            runCurrent()
            assertTrue(viewModel.state.value.favorites.isEmpty())
            assertTrue(viewModel.state.value.enabledSections.isEmpty())
        } finally {
            api.releaseFavoritesPageIfNeeded(FavoritesPage(emptyList(), null))
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `null refresh clears resources synchronously and ignores a non cooperative late page`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val api = ControlledSavedResourcesApi().apply { blockNextFavoritesPage = true }
        try {
            val viewModel = viewModel(api)
            runCurrent()

            viewModel.start(enabledConfig())
            runCurrent()
            assertTrue(api.favoritesPageStarted.isCompleted)

            try {
                viewModel.start(null)

                val revoked = viewModel.state.value
                assertFalse(revoked.busy)
                assertTrue(revoked.enabledSections.isEmpty())
                assertTrue(revoked.favorites.isEmpty())
                assertTrue(revoked.loadedSections.isEmpty())
                assertNull(revoked.favoritesNextCursor)

                api.releaseFavoritesPage(FavoritesPage(listOf(favorite(LATE_FAVORITE_ID)), null))
                runCurrent()

                assertTrue(viewModel.state.value.favorites.isEmpty())
                assertTrue(viewModel.state.value.enabledSections.isEmpty())
                val callsAtRevocation = api.listFavoritesCalls
                viewModel.refresh()
                viewModel.loadMore()
                runCurrent()
                assertEquals(callsAtRevocation, api.listFavoritesCalls)
            } finally {
                api.releaseFavoritesPageIfNeeded(FavoritesPage(emptyList(), null))
                runCurrent()
            }
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `disabled refresh clears operation state and ignores a non cooperative late create`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val api = ControlledSavedResourcesApi()
        try {
            val viewModel = viewModel(api)
            runCurrent()
            val enabled = enabledConfig()
            val result = searchResult()
            val response = searchResponse(result)

            viewModel.start(enabled)
            runCurrent()
            api.blockNextFavoriteCreate = true
            viewModel.createFavorite(enabled, response, result, FavoriteGroup.WANT_TO_GO)
            runCurrent()
            assertTrue(api.favoriteCreateStarted.isCompleted)

            try {
                viewModel.start(disabledConfig())

                val revoked = viewModel.state.value
                assertFalse(revoked.busy)
                assertTrue(revoked.enabledSections.isEmpty())
                assertTrue(revoked.favorites.isEmpty())
                assertFalse(revoked.favoriteSaved)

                api.releaseFavoriteCreate(favorite(LATE_FAVORITE_ID))
                runCurrent()

                assertTrue(viewModel.state.value.favorites.isEmpty())
                assertFalse(viewModel.state.value.favoriteSaved)
                assertTrue(viewModel.state.value.enabledSections.isEmpty())
            } finally {
                api.releaseFavoriteCreateIfNeeded(favorite(LATE_FAVORITE_ID))
                runCurrent()
            }
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `disabled then enabled reloads from a clean state without serving old records`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = ControlledSavedResourcesApi().apply {
                favoritePages.addLast(FavoritesPage(listOf(favorite(OLD_FAVORITE_ID)), null))
                favoritePages.addLast(FavoritesPage(listOf(favorite(NEW_FAVORITE_ID)), null))
            }
            val viewModel = viewModel(api)
            runCurrent()

            viewModel.start(enabledConfig())
            runCurrent()
            assertEquals(listOf(OLD_FAVORITE_ID), viewModel.state.value.favorites.map { it.favoriteId })
            assertEquals(1, api.listFavoritesCalls)

            viewModel.start(disabledConfig())
            assertTrue(viewModel.state.value.favorites.isEmpty())
            assertTrue(viewModel.state.value.enabledSections.isEmpty())
            assertTrue(viewModel.state.value.loadedSections.isEmpty())

            viewModel.refresh()
            runCurrent()
            assertEquals(1, api.listFavoritesCalls)

            viewModel.start(enabledConfig())
            runCurrent()

            assertEquals(2, api.listFavoritesCalls)
            assertEquals(listOf(NEW_FAVORITE_ID), viewModel.state.value.favorites.map { it.favoriteId })
            assertEquals(
                setOf(SavedResourcesSection.FAVORITES),
                viewModel.state.value.loadedSections,
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `detail capability application does not read account collections before an explicit mutation`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val api = ControlledSavedResourcesApi()
            val viewModel = viewModel(api)
            runCurrent()

            viewModel.applyCapabilities(enabledConfig())
            runCurrent()

            assertEquals(0, api.listFavoritesCalls)
            assertEquals(0, api.createFavoriteCalls)

            val result = searchResult()
            viewModel.createFavorite(
                enabledConfig(),
                searchResponse(result),
                result,
                FavoriteGroup.WANT_TO_GO,
            )
            runCurrent()

            assertEquals(0, api.listFavoritesCalls)
            assertEquals(1, api.createFavoriteCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private suspend fun viewModel(
        api: SavedResourcesApi,
        gate: com.chishenme.app.feature.config.RuntimeAppVersionGate =
            com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
    ): SavedResourcesViewModel {
        val authRepository = signedInAuthRepository()
        check(authRepository.restoreSession() is AuthOutcome.Success)
        val repository = SavedResourcesRepository(
            api = api,
            auth = AlwaysAuthenticatedExecutor,
            idempotencyKeyFactory = { IDEMPOTENCY_KEY },
            testOnly = Unit,
        )
        return SavedResourcesViewModel(
            repository,
            authRepository,
            gate,
        )
    }
}

private object AlwaysAuthenticatedExecutor : AuthenticatedRequestExecutor {
    override suspend fun <Value> executeAuthenticated(
        call: suspend (authorizationHeader: String) -> Value,
    ): AuthOutcome<Value> = AuthOutcome.Success(call("Bearer test-access"))
}

private class ControlledSavedResourcesApi : SavedResourcesApi {
    val favoritePages = java.util.ArrayDeque<FavoritesPage>()
    val favoritesPageStarted = CompletableDeferred<Unit>()
    val favoriteCreateStarted = CompletableDeferred<Unit>()
    var blockNextFavoritesPage = false
    var blockNextFavoriteCreate = false
    var listFavoritesCalls = 0
    var createFavoriteCalls = 0
    private var favoritesPageContinuation: Continuation<Response<FavoritesPage>>? = null
    private var favoriteCreateContinuation: Continuation<Response<FavoriteRecord>>? = null

    override suspend fun listFavorites(
        authorization: String,
        cursor: String?,
        limit: String,
        group: FavoriteGroup?,
    ): Response<FavoritesPage> {
        listFavoritesCalls += 1
        if (blockNextFavoritesPage) {
            blockNextFavoritesPage = false
            return suspendCoroutine { continuation ->
                favoritesPageContinuation = continuation
                favoritesPageStarted.complete(Unit)
            }
        }
        return Response.success(favoritePages.pollFirst() ?: FavoritesPage(emptyList(), null))
    }

    override suspend fun createFavorite(
        authorization: String,
        request: FavoriteMutationRequest,
    ): Response<FavoriteRecord> {
        createFavoriteCalls += 1
        if (blockNextFavoriteCreate) {
            blockNextFavoriteCreate = false
            return suspendCoroutine { continuation ->
                favoriteCreateContinuation = continuation
                favoriteCreateStarted.complete(Unit)
            }
        }
        return Response.success(201, favorite(NEW_FAVORITE_ID))
    }

    fun releaseFavoritesPage(page: FavoritesPage) {
        checkNotNull(favoritesPageContinuation).also { continuation ->
            favoritesPageContinuation = null
            continuation.resume(Response.success(page))
        }
    }

    fun releaseFavoritesPageIfNeeded(page: FavoritesPage) {
        favoritesPageContinuation?.also { continuation ->
            favoritesPageContinuation = null
            continuation.resume(Response.success(page))
        }
    }

    fun releaseFavoriteCreate(record: FavoriteRecord) {
        checkNotNull(favoriteCreateContinuation).also { continuation ->
            favoriteCreateContinuation = null
            continuation.resume(Response.success(201, record))
        }
    }

    fun releaseFavoriteCreateIfNeeded(record: FavoriteRecord) {
        favoriteCreateContinuation?.also { continuation ->
            favoriteCreateContinuation = null
            continuation.resume(Response.success(201, record))
        }
    }

    override suspend fun updateFavoriteGroup(
        authorization: String,
        favoriteId: String,
        request: UpdateFavoriteGroupRequest,
    ): Response<FavoriteRecord> = Response.success(favorite(favoriteId).copy(group = request.group))

    override suspend fun deleteFavorite(authorization: String, favoriteId: String): Response<Unit> =
        Response.success(204, Unit)

    override suspend fun listHistory(
        authorization: String,
        cursor: String?,
        limit: String,
        action: RecommendationHistoryAction?,
    ): Response<RecommendationHistoryPage> = Response.success(
        RecommendationHistoryPage(emptyList(), null, 90),
    )

    override suspend fun clearHistory(authorization: String): Response<Unit> = Response.success(204, Unit)

    override suspend fun listPrivateFeedback(
        authorization: String,
        cursor: String?,
        limit: String,
        type: PrivateFeedbackType?,
    ): Response<PrivateFeedbackPage> = Response.success(PrivateFeedbackPage(emptyList(), null))

    override suspend fun createPrivateFeedback(
        authorization: String,
        request: CreatePrivateFeedbackRequest,
    ): Response<PrivateFeedbackRecord> = error("unused")

    override suspend fun deletePrivateFeedback(
        authorization: String,
        feedbackId: String,
    ): Response<Unit> = Response.success(204, Unit)

    override suspend fun clearPrivateFeedback(authorization: String): Response<Unit> = Response.success(204, Unit)
}

private suspend fun signedInAuthRepository(): AuthRepository {
    val store = AuthSessionStore(SavedResourcesPreferencesDataStore(), SavedResourcesReversibleCipher())
    store.installationId()
    store.save(
        AuthSessionToPersist(
            userId = USER_ID,
            sessionId = SESSION_ID,
            refreshToken = "r".repeat(43),
            refreshTokenExpiresAt = Instant.now().plusSeconds(86_400),
        ),
    )
    return AuthRepository(refreshingAuthApi(), store)
}

private fun refreshingAuthApi(): AuthApi = Proxy.newProxyInstance(
    AuthApi::class.java.classLoader,
    arrayOf(AuthApi::class.java),
) { _, method, _ ->
    when (method.name) {
        "refresh" -> AuthTokenResponse(
            userId = USER_ID,
            sessionId = SESSION_ID,
            tokenType = "Bearer",
            accessToken = "a".repeat(43),
            accessTokenExpiresAt = Instant.now().plusSeconds(600).toString(),
            refreshToken = "b".repeat(43),
            refreshTokenExpiresAt = Instant.now().plusSeconds(86_400).toString(),
        )
        else -> error("Unexpected AuthApi call: ${method.name}")
    }
} as AuthApi

private class SavedResourcesPreferencesDataStore : DataStore<Preferences> {
    private val state = MutableStateFlow<Preferences>(emptyPreferences())
    override val data: Flow<Preferences> = state

    override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
        transform(state.value).also { state.value = it }
}

private class SavedResourcesReversibleCipher : RefreshTokenCipher {
    private val values = mutableMapOf<String, String>()

    override fun encrypt(plaintext: String, associatedData: ByteArray): String {
        val envelope = "saved-resources-test-envelope"
        values[envelope + associatedData.decodeToString()] = plaintext
        return envelope
    }

    override fun decrypt(envelope: String, associatedData: ByteArray): String =
        values[envelope + associatedData.decodeToString()] ?: error("missing test value")

    override fun deleteKey() {
        values.clear()
    }
}

private fun enabledConfig() = FeatureConfig(
    coverageName = "北京四环试点区",
    dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT,
    aiEnabled = false,
    accountsEnabled = true,
    favoritesEnabled = true,
    minimumSupportedVersion = "0.1.0",
    ruleVersion = "rule-v1",
    promptVersion = "prompt-v1",
    modelVersion = "rule-fallback-v1",
    persistenceCapabilities = PersistenceCapabilities(
        favoritesEnabled = true,
        historyEnabled = false,
        privateFeedbackEnabled = false,
        savedResourceIdsEnabled = true,
    ),
    authCapabilities = AuthCapabilities(
        accountsEnabled = true,
        registrationEnabled = false,
        phoneEnabled = true,
        wechatEnabled = true,
        emailEnabled = true,
        qqEnabled = false,
        dataExportEnabled = false,
    ),
)

private fun disabledConfig() = enabledConfig().copy(
    accountsEnabled = false,
    favoritesEnabled = false,
    persistenceCapabilities = PersistenceCapabilities.Disabled,
    authCapabilities = AuthCapabilities(
        accountsEnabled = false,
        registrationEnabled = false,
        phoneEnabled = false,
        wechatEnabled = false,
        emailEnabled = false,
        qqEnabled = false,
        dataExportEnabled = false,
    ),
)

private fun favorite(id: String) = FavoriteRecord(
    favoriteId = id,
    group = FavoriteGroup.WANT_TO_GO,
    createdAt = NOW,
    presentation = PersistedPlacePresentation(
        presentationStatus = PersistedPresentationStatus.AVAILABLE,
        name = "学院路面馆",
        address = "海淀区学院路",
        sourceLabel = "经授权餐厅数据",
        dataMode = RecommendationDataMode.LIVE,
        openStatus = OpenStatus.OPEN,
        averageCostYuan = 25.0,
        tags = listOf("面食"),
        resolvedAt = NOW,
    ),
)

private fun searchResponse(result: PlaceSearchResult) = PlaceSearchResponse(
    requestId = REQUEST_ID,
    coverage = Coverage.BEIJING_FOURTH_RING,
    results = listOf(result),
    notice = null,
)

private fun searchResult() = PlaceSearchResult(
    resultToken = "S".repeat(43),
    rank = 1,
    name = "学院路面馆",
    address = "海淀区学院路",
    location = PlaceSearchCoordinate(39.9, 116.4, CoordinateReferenceSystem.GCJ02),
    distanceMeters = 300,
    sourceLabel = "经授权餐厅数据",
    sourceRating = null,
    averageCostYuan = 25.0,
    openStatus = OpenStatus.OPEN,
    tags = listOf("面食"),
    dataMode = "LIVE",
    actions = RecommendationActions(false, false, false, false),
)

private const val USER_ID = "11111111-1111-4111-8111-111111111111"
private const val SESSION_ID = "22222222-2222-4222-8222-222222222222"
private const val REQUEST_ID = "33333333-3333-4333-8333-333333333333"
private const val IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444"
private const val OLD_FAVORITE_ID = "55555555-5555-4555-8555-555555555555"
private const val NEW_FAVORITE_ID = "66666666-6666-4666-8666-666666666666"
private const val LATE_FAVORITE_ID = "77777777-7777-4777-8777-777777777777"
private const val NOW = "2026-08-21T00:00:00Z"
