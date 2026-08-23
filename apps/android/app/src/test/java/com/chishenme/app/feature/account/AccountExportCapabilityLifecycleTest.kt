package com.chishenme.app.feature.account

import com.chishenme.app.auth.qq.QqConsentGate
import com.chishenme.app.auth.qq.QqOAuthCoordinator
import com.chishenme.app.auth.qq.QqOAuthManager
import com.chishenme.app.auth.qq.QqSdkCallback
import com.chishenme.app.auth.qq.QqSdkSession
import com.chishenme.app.auth.qq.QqSdkSessionFactory
import com.chishenme.app.auth.wechat.WechatConsentGate
import com.chishenme.app.auth.wechat.WechatOAuthCoordinator
import com.chishenme.app.auth.wechat.WechatOAuthManager
import com.chishenme.app.auth.wechat.WechatSdkSession
import com.chishenme.app.auth.wechat.WechatSdkSessionFactory
import com.chishenme.app.data.AccountAuthActions
import com.chishenme.app.data.AccountExportActions
import com.chishenme.app.data.AccountExportOutcome
import com.chishenme.app.data.AuthOutcome
import com.chishenme.app.data.AuthFailureKind
import com.chishenme.app.data.LocalAuthSession
import com.chishenme.app.data.remote.AccountExportResponse
import com.chishenme.app.data.remote.AccountExportStatus
import com.chishenme.app.data.remote.AccountExportStatusResponse
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.AuthCodeChallenge
import com.chishenme.app.data.remote.AuthIdentityBinding
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthSessionSummary
import com.chishenme.app.data.remote.DeleteAccountResponse
import com.chishenme.app.data.remote.OAuthPurpose
import com.chishenme.app.data.remote.OAuthStateResponse
import com.chishenme.app.data.remote.OtpPurpose
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AccountExportCapabilityLifecycleTest {
    @Test
    fun `local logout cancels data rights material check without reviving it as local material`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val checkStarted = CompletableDeferred<Unit>()
            val checkCancelled = CompletableDeferred<Unit>()
            val auth = FakeAuthActions().apply {
                hasLocalMaterialOperation = {
                    checkStarted.complete(Unit)
                    try {
                        awaitCancellation()
                    } finally {
                        checkCancelled.complete(Unit)
                    }
                }
            }
            val viewModel = viewModel(FakeExportActions(latest = null), auth)

            viewModel.startDataRightsOnly()
            runCurrent()
            assertTrue(checkStarted.isCompleted)

            viewModel.logout()
            runCurrent()

            assertTrue(checkCancelled.isCompleted)
            assertEquals(1, auth.logoutCalls)
            assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
            assertFalse(viewModel.state.value.localSessionMaterialPresent)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `failed data rights refresh keeps local logout reachable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate = com.chishenme.app.feature.config.RuntimeAppVersionGate("0.1.0").apply {
                markConfigurationUntrusted(1)
                acceptTrustedConfiguration(1, "9.0.0")
            }
            val auth = FakeAuthActions().apply { failRestore = true }
            val viewModel = viewModel(FakeExportActions(latest = null), auth, gate)

            viewModel.startDataRightsOnly()
            runCurrent()
            assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
            assertTrue(viewModel.state.value.localSessionMaterialPresent)

            viewModel.logout()
            runCurrent()
            assertEquals(1, auth.logoutCalls)
            assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
            assertFalse(viewModel.state.value.localSessionMaterialPresent)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `fresh update page restores only data rights session then permits deletion`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate = com.chishenme.app.feature.config.RuntimeAppVersionGate("0.1.0").apply {
                markConfigurationUntrusted(1)
                acceptTrustedConfiguration(1, "9.0.0")
            }
            val auth = FakeAuthActions()
            val exports = FakeExportActions(latest = null)
            val viewModel = viewModel(exports, auth, gate)

            viewModel.startDataRightsOnly()
            runCurrent()
            assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
            assertEquals(1, auth.restoreCalls)
            assertEquals(0, exports.latestCalls)

            viewModel.deleteAccount()
            runCurrent()
            assertEquals(1, auth.deleteCalls)
            assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
            assertEquals(0, exports.latestCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `update required preserves local logout`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate()
            val auth = FakeAuthActions()
            val viewModel = viewModel(FakeExportActions(latest = null), auth, gate)
            viewModel.start(capabilities(dataExportEnabled = false))
            runCurrent()
            assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)

            gate.markConfigurationUntrusted(2)
            gate.acceptTrustedConfiguration(2, "9.0.0")
            runCurrent()
            viewModel.logout()
            runCurrent()

            assertEquals(1, auth.logoutCalls)
            assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `update required preserves signed in account deletion right`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate = com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate()
            val auth = FakeAuthActions()
            val viewModel = viewModel(FakeExportActions(latest = null), auth, gate)
            viewModel.start(capabilities(dataExportEnabled = false))
            runCurrent()
            assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)

            gate.markConfigurationUntrusted(2)
            gate.acceptTrustedConfiguration(2, "9.0.0")
            runCurrent()
            viewModel.deleteAccount()
            runCurrent()

            assertEquals(1, auth.deleteCalls)
            assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `disabled capability never reaches any export repository operation`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val exports = FakeExportActions(latest = readyExport())
            val viewModel = viewModel(exports)

            viewModel.start(capabilities(dataExportEnabled = false))
            runCurrent()
            viewModel.setIncludeBehaviorHistory(false)
            viewModel.refreshExport()
            viewModel.requestExport()
            viewModel.downloadExport("content://documents/export.json")
            runCurrent()

            assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
            assertFalse(viewModel.state.value.dataExportEnabled)
            assertTrue(viewModel.state.value.includeBehaviorHistory)
            assertNull(viewModel.state.value.export)
            assertEquals(0, exports.latestCalls)
            assertEquals(0, exports.requestCalls)
            assertEquals(0, exports.downloadCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `enabled capability preserves latest request and download behavior`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val exports = FakeExportActions(latest = readyExport())
            val viewModel = viewModel(exports)

            viewModel.start(capabilities(dataExportEnabled = true))
            runCurrent()
            assertEquals(1, exports.latestCalls)
            assertEquals(AccountExportStatus.READY, viewModel.state.value.export?.status)

            viewModel.downloadExport("content://documents/export.json")
            runCurrent()
            viewModel.requestExport()
            runCurrent()

            assertEquals(1, exports.downloadCalls)
            assertEquals(1, exports.requestCalls)
            assertEquals(AccountExportStatus.QUEUED, viewModel.state.value.export?.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `disable then re-enable waits for cancelled download cleanup before a new API call`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val started = CompletableDeferred<Unit>()
            val cleanupRelease = CompletableDeferred<Unit>()
            val cleanupFinished = CompletableDeferred<Unit>()
            val exports = FakeExportActions(latest = readyExport()).apply {
                downloadOperation = {
                    started.complete(Unit)
                    try {
                        awaitCancellation()
                    } finally {
                        withContext(NonCancellable) {
                            cleanupRelease.await()
                            cleanupFinished.complete(Unit)
                        }
                    }
                }
            }
            val viewModel = viewModel(exports)
            val enabled = capabilities(dataExportEnabled = true)

            viewModel.start(enabled)
            runCurrent()
            viewModel.downloadExport("content://documents/export.json")
            runCurrent()
            assertTrue(started.isCompleted)

            viewModel.start(enabled.copy(dataExportEnabled = false))
            viewModel.start(enabled)
            runCurrent()

            try {
                assertFalse(cleanupFinished.isCompleted)
                assertTrue(viewModel.state.value.dataExportEnabled)
                assertTrue(viewModel.state.value.exportBusy)
                assertEquals(1, exports.latestCalls)
                assertEquals(1, exports.downloadCalls)
            } finally {
                cleanupRelease.complete(Unit)
                runCurrent()
            }

            assertTrue(cleanupFinished.isCompleted)
            assertFalse(viewModel.state.value.exportBusy)
            assertEquals(2, exports.latestCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `logout cancels an in-flight export before switching to guest`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val started = CompletableDeferred<Unit>()
            val cancelled = CompletableDeferred<Unit>()
            val auth = FakeAuthActions()
            val exports = FakeExportActions(latest = null).apply {
                requestOperation = {
                    started.complete(Unit)
                    try {
                        awaitCancellation()
                    } finally {
                        cancelled.complete(Unit)
                    }
                }
            }
            val viewModel = viewModel(exports, auth)

            viewModel.start(capabilities(dataExportEnabled = true))
            runCurrent()
            viewModel.requestExport()
            runCurrent()
            assertTrue(started.isCompleted)

            viewModel.logout()
            runCurrent()

            assertTrue(cancelled.isCompleted)
            assertEquals(1, auth.logoutCalls)
            assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
            assertNull(viewModel.state.value.export)
            assertFalse(viewModel.state.value.exportBusy)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun viewModel(
        exports: FakeExportActions,
        auth: FakeAuthActions = FakeAuthActions(),
        gate: com.chishenme.app.feature.config.RuntimeAppVersionGate =
            com.chishenme.app.feature.config.compatibleRuntimeAppVersionGate(),
    ) = AccountViewModel(
        repository = auth,
        exportRepository = exports,
        wechatOAuth = testWechatManager(),
        qqOAuth = testQqManager(),
        runtimeAppVersionGate = gate,
    )

    private fun capabilities(dataExportEnabled: Boolean) = AuthCapabilities(
        accountsEnabled = true,
        registrationEnabled = false,
        phoneEnabled = true,
        wechatEnabled = true,
        emailEnabled = true,
        qqEnabled = false,
        dataExportEnabled = dataExportEnabled,
    )

    private fun readyExport() = AccountExportStatusResponse(
        exportId = EXPORT_ID,
        status = AccountExportStatus.READY,
        requestedAt = "2026-08-21T00:00:00Z",
        expiresAt = "2026-08-28T00:00:00Z",
        includeBehaviorHistory = true,
        downloadAvailable = true,
        readyAt = "2026-08-21T00:01:00Z",
        sizeBytes = 1_024,
        sha256 = "a".repeat(64),
        contentType = "application/json; charset=utf-8",
    )

    private fun testWechatManager() = WechatOAuthManager(
        consentGate = WechatConsentGate { false },
        sessionFactory = object : WechatSdkSessionFactory {
            override val isConfigured = false
            override fun create(): WechatSdkSession = error("unused")
        },
        coordinator = WechatOAuthCoordinator(),
    )

    private fun testQqManager() = QqOAuthManager(
        consentGate = QqConsentGate { false },
        sessionFactory = object : QqSdkSessionFactory {
            override val isConfigured = false
            override fun create(onCallback: (QqSdkCallback) -> Unit): QqSdkSession = error("unused")
            override fun revokePrivacyConsent() = Unit
        },
        coordinator = QqOAuthCoordinator(),
    )

    private companion object {
        const val EXPORT_ID = "11111111-1111-4111-8111-111111111111"
    }
}

private class FakeExportActions(
    private val latest: AccountExportStatusResponse?,
) : AccountExportActions {
    var latestCalls = 0
    var requestCalls = 0
    var downloadCalls = 0
    var requestOperation: suspend () -> AccountExportOutcome<AccountExportResponse> = {
        AccountExportOutcome.Success(
            AccountExportResponse(
                exportId = "22222222-2222-4222-8222-222222222222",
                status = AccountExportStatus.QUEUED,
                requestedAt = "2026-08-21T01:00:00Z",
                expiresAt = "2026-08-28T01:00:00Z",
                includeBehaviorHistory = true,
            ),
        )
    }
    var downloadOperation: suspend () -> AccountExportOutcome<Unit> = {
        AccountExportOutcome.Success(Unit)
    }

    override suspend fun request(includeBehaviorHistory: Boolean): AccountExportOutcome<AccountExportResponse> {
        requestCalls += 1
        return requestOperation()
    }

    override suspend fun latest(): AccountExportOutcome<AccountExportStatusResponse?> {
        latestCalls += 1
        return AccountExportOutcome.Success(latest)
    }

    override suspend fun download(
        status: AccountExportStatusResponse,
        destinationUri: String,
    ): AccountExportOutcome<Unit> {
        downloadCalls += 1
        return downloadOperation()
    }
}

private class FakeAuthActions : AccountAuthActions {
    var logoutCalls = 0
    var deleteCalls = 0
    var restoreCalls = 0
    var failRestore = false
    var hasLocalMaterialOperation: suspend () -> Boolean = { session != null }
    private var session: LocalAuthSession? = LocalAuthSession(
        userId = "33333333-3333-4333-8333-333333333333",
        sessionId = "44444444-4444-4444-8444-444444444444",
        accessTokenExpiresAt = Instant.now().plusSeconds(600),
        refreshTokenExpiresAt = Instant.now().plusSeconds(86_400),
    )

    override suspend fun hasLocalSessionMaterial(): Boolean = hasLocalMaterialOperation()

    override suspend fun restoreSession(): AuthOutcome<LocalAuthSession?> {
        restoreCalls += 1
        if (failRestore) {
            return AuthOutcome.Failure(AuthFailureKind.UNAVAILABLE, "暂时无法刷新登录状态")
        }
        return AuthOutcome.Success(session)
    }

    override suspend fun identities(): AuthOutcome<List<AuthIdentityBinding>> = AuthOutcome.Success(emptyList())

    override suspend fun sessions(): AuthOutcome<List<AuthSessionSummary>> = AuthOutcome.Success(emptyList())

    override suspend fun logout(): AuthOutcome<Unit> {
        logoutCalls += 1
        session = null
        return AuthOutcome.Success(Unit)
    }

    override suspend fun requestPhoneCode(
        rawPhone: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> = error("unused")

    override suspend fun requestEmailCode(
        rawEmail: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> = error("unused")

    override suspend fun createOAuthState(
        provider: AuthIdentityType,
        purpose: OAuthPurpose,
        phoneChallengeId: String?,
    ): AuthOutcome<OAuthStateResponse> = error("unused")

    override suspend fun registerPhoneWechat(
        challengeId: String,
        otpCode: String,
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession> = error("unused")

    override suspend fun loginWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
    ): AuthOutcome<LocalAuthSession> = error("unused")

    override suspend fun loginWithWechat(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession> = error("unused")

    override suspend fun loginWithQq(
        oauthState: String,
        qqAccessToken: String,
    ): AuthOutcome<LocalAuthSession> = error("unused")

    override suspend fun bindWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
    ): AuthOutcome<AuthIdentityBinding> = error("unused")

    override suspend fun bindWithQq(
        oauthState: String,
        qqAccessToken: String,
    ): AuthOutcome<AuthIdentityBinding> = error("unused")

    override suspend fun unbindIdentity(bindingId: String): AuthOutcome<Unit> = error("unused")

    override suspend fun revokeSession(sessionId: String): AuthOutcome<Unit> = error("unused")

    override suspend fun deleteAccount(): AuthOutcome<DeleteAccountResponse> {
        deleteCalls += 1
        session = null
        return AuthOutcome.Success(
            DeleteAccountResponse(
                deletionId = "55555555-5555-4555-8555-555555555555",
                userId = "33333333-3333-4333-8333-333333333333",
                status = "PENDING_DELETION",
                invalidatedAt = "2026-08-21T08:00:00Z",
                backupDeletionDeadline = "2026-09-20T08:00:00Z",
            ),
        )
    }
}
