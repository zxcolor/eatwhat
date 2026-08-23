package com.chishenme.app.feature.account

import android.app.Activity
import android.content.Intent
import com.chishenme.app.auth.qq.QqConsentGate
import com.chishenme.app.auth.qq.QqLoginHost
import com.chishenme.app.auth.qq.QqOAuthCoordinator
import com.chishenme.app.auth.qq.QqOAuthEvent
import com.chishenme.app.auth.qq.QqOAuthManager
import com.chishenme.app.auth.qq.QqSdkCallback
import com.chishenme.app.auth.qq.QqSdkSession
import com.chishenme.app.auth.qq.QqSdkSessionFactory
import com.chishenme.app.auth.wechat.WechatConsentGate
import com.chishenme.app.auth.wechat.WechatOAuthCoordinator
import com.chishenme.app.auth.wechat.WechatOAuthManager
import com.chishenme.app.auth.wechat.WechatSdkCallback
import com.chishenme.app.auth.wechat.WechatSdkSession
import com.chishenme.app.auth.wechat.WechatSdkSessionFactory
import com.chishenme.app.data.AccountAuthActions
import com.chishenme.app.data.AccountExportActions
import com.chishenme.app.data.AccountExportOutcome
import com.chishenme.app.data.AuthOutcome
import com.chishenme.app.data.LocalAuthSession
import com.chishenme.app.data.remote.AccountExportResponse
import com.chishenme.app.data.remote.AccountExportStatusResponse
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.AuthCodeChallenge
import com.chishenme.app.data.remote.AuthIdentityBinding
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.AuthSessionSummary
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.DeleteAccountResponse
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.OAuthPurpose
import com.chishenme.app.data.remote.OAuthStateResponse
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import java.time.Instant
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
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

@OptIn(ExperimentalCoroutinesApi::class)
class AccountRemoteConfigLifecycleTest {
    @Test
    fun `configuration recreation can reapply the same ready generation after local suspension`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val auth = ConfigLifecycleAuthActions()
            val fixture = fixture(auth)
            val ready = ready(1, capabilities(wechat = true))
            fixture.start(ready)
            runCurrent()

            fixture.viewModel.suspendRemoteAccessForForegroundRefresh()
            fixture.viewModel.startWechatLogin()
            runCurrent()
            assertEquals(0, auth.oauthStateCalls)

            fixture.start(ready)
            runCurrent()
            fixture.viewModel.startWechatLogin()
            runCurrent()
            assertEquals(1, auth.oauthStateCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `initial loading never restores and a non cooperative old restore cannot write after revoke`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val auth = ConfigLifecycleAuthActions().apply { holdNextRestore = true }
        try {
            val fixture = fixture(auth)

            fixture.start(RemoteFeatureConfigState.Loading(1))
            runCurrent()
            assertEquals(0, auth.restoreCalls)
            assertEquals(AccountStatus.CHECKING, fixture.viewModel.state.value.status)

            fixture.start(ready(1, capabilities(wechat = true, qq = true)))
            runCurrent()
            assertEquals(1, auth.restoreCalls)
            assertTrue(auth.restoreIsWaiting)

            fixture.start(RemoteFeatureConfigState.Loading(2))
            fixture.start(ready(2, capabilities(accounts = false)))
            auth.releaseRestore(AuthOutcome.Success(testSession()))
            runCurrent()

            assertEquals(AccountStatus.GUEST, fixture.viewModel.state.value.status)
            assertFalse(fixture.viewModel.state.value.busy)
            assertTrue(fixture.viewModel.state.value.identities.isEmpty())
            assertTrue(fixture.viewModel.state.value.sessions.isEmpty())
        } finally {
            auth.releaseRestoreIfNeeded(AuthOutcome.Success(null))
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `wechat callback during loading is consumed once only after latest ready allows provider`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val auth = ConfigLifecycleAuthActions()
            val fixture = fixture(auth)
            fixture.start(ready(1, capabilities(wechat = true)))
            runCurrent()

            fixture.viewModel.startWechatLogin()
            runCurrent()
            assertEquals(1, auth.oauthStateCalls)

            fixture.gate.markConfigurationUntrusted(2)
            fixture.viewModel.suspendRemoteAccessForForegroundRefresh()
            fixture.wechatManager.acceptSdkCallback(
                WechatSdkCallback.Authorized(OAUTH_STATE, WECHAT_CODE),
            )
            runCurrent()
            assertEquals(0, auth.wechatLoginCalls)

            fixture.start(ready(2, capabilities(wechat = true)))
            runCurrent()
            fixture.start(ready(2, capabilities(wechat = true)))
            runCurrent()

            assertEquals(1, auth.wechatLoginCalls)
            assertEquals(AccountStatus.SIGNED_IN, fixture.viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `wechat callback staged during loading is cleared by explicit provider denial`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val auth = ConfigLifecycleAuthActions()
            val fixture = fixture(auth)
            fixture.start(ready(1, capabilities(wechat = true)))
            runCurrent()
            fixture.viewModel.startWechatLogin()
            runCurrent()

            fixture.start(RemoteFeatureConfigState.Loading(2))
            fixture.wechatManager.acceptSdkCallback(
                WechatSdkCallback.Authorized(OAUTH_STATE, WECHAT_CODE),
            )
            runCurrent()
            fixture.start(ready(2, capabilities(wechat = false)))
            runCurrent()
            fixture.start(ready(3, capabilities(wechat = true)))
            runCurrent()

            assertEquals(0, auth.wechatLoginCalls)
            assertEquals(AccountStatus.GUEST, fixture.viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `qq proof staged during loading is discarded by terminal unavailable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val auth = ConfigLifecycleAuthActions()
            val fixture = fixture(auth)
            fixture.start(ready(1, capabilities(qq = true)))
            runCurrent()
            fixture.viewModel.startQqLogin(ConfigLifecycleQqHost())
            runCurrent()

            fixture.start(RemoteFeatureConfigState.Loading(2))
            val observed = async(start = CoroutineStart.UNDISPATCHED) {
                fixture.qqManager.events.first() as QqOAuthEvent.Authorized
            }
            fixture.qqFactory.callback?.invoke(QqSdkCallback.Authorized(QQ_TOKEN))
            runCurrent()
            val stagedProof = observed.await()
            assertEquals(0, auth.qqLoginCalls)

            fixture.start(RemoteFeatureConfigState.Unavailable(2))
            runCurrent()
            assertNull(stagedProof.consumeProof { _, _ -> "proof was retained" })

            fixture.start(ready(3, capabilities(qq = true)))
            runCurrent()
            assertEquals(0, auth.qqLoginCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun fixture(auth: ConfigLifecycleAuthActions): ConfigLifecycleFixture {
        val runtimeGate = com.chishenme.app.feature.config.RuntimeAppVersionGate("0.1.0")
        val wechatFactory = ConfigLifecycleWechatFactory()
        val wechatManager = WechatOAuthManager(
            consentGate = WechatConsentGate { true },
            sessionFactory = wechatFactory,
            coordinator = WechatOAuthCoordinator { NOW },
        )
        val qqFactory = ConfigLifecycleQqFactory()
        val qqManager = QqOAuthManager(
            consentGate = QqConsentGate { true },
            sessionFactory = qqFactory,
            coordinator = QqOAuthCoordinator { NOW },
        )
        return ConfigLifecycleFixture(
            viewModel = AccountViewModel(
                repository = auth,
                exportRepository = ConfigLifecycleNoExports,
                wechatOAuth = wechatManager,
                qqOAuth = qqManager,
                runtimeAppVersionGate = runtimeGate,
            ),
            wechatManager = wechatManager,
            qqManager = qqManager,
            qqFactory = qqFactory,
            gate = runtimeGate,
        )
    }

    private fun ready(generation: Long, capabilities: AuthCapabilities) =
        RemoteFeatureConfigState.Ready(
            generation = generation,
            config = FeatureConfig(
                coverageName = "测试覆盖区",
                dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
                aiEnabled = false,
                accountsEnabled = capabilities.accountsEnabled,
                favoritesEnabled = false,
                minimumSupportedVersion = "0.1.0",
                ruleVersion = "test-rule",
                promptVersion = "test-prompt",
                modelVersion = "test-model",
                authCapabilities = capabilities,
            ),
        )

    private fun capabilities(
        accounts: Boolean = true,
        wechat: Boolean = false,
        qq: Boolean = false,
    ) = AuthCapabilities(
        accountsEnabled = accounts,
        registrationEnabled = false,
        phoneEnabled = accounts,
        wechatEnabled = accounts && wechat,
        emailEnabled = accounts,
        qqEnabled = accounts && qq,
        dataExportEnabled = false,
    )

    companion object {
        val NOW: Instant = Instant.parse("2026-08-21T04:00:00Z")
        const val OAUTH_STATE = "sssssssssssssssssssssssssssssssssssssssssss"
        const val WECHAT_CODE = "private-wechat-authorization-code"
        const val QQ_TOKEN = "private-qq-access-token"
    }
}

private data class ConfigLifecycleFixture(
    val viewModel: AccountViewModel,
    val wechatManager: WechatOAuthManager,
    val qqManager: QqOAuthManager,
    val qqFactory: ConfigLifecycleQqFactory,
    val gate: com.chishenme.app.feature.config.RuntimeAppVersionGate,
) {
    fun start(remote: RemoteFeatureConfigState) {
        when (remote) {
            is RemoteFeatureConfigState.Loading -> gate.markConfigurationUntrusted(remote.generation)
            is RemoteFeatureConfigState.Ready -> {
                if (gate.currentState.observedConfigurationGeneration != remote.generation) {
                    gate.markConfigurationUntrusted(remote.generation)
                }
                gate.acceptTrustedConfiguration(
                    remote.generation,
                    remote.config.minimumSupportedVersion,
                )
            }
            is RemoteFeatureConfigState.Unavailable -> {
                if (gate.currentState.observedConfigurationGeneration != remote.generation) {
                    gate.markConfigurationUntrusted(remote.generation)
                }
                gate.markConfigurationUnavailable(remote.generation)
            }
            is RemoteFeatureConfigState.Incompatible -> {
                if (gate.currentState.observedConfigurationGeneration != remote.generation) {
                    gate.markConfigurationUntrusted(remote.generation)
                }
                gate.markConfigurationIncompatible(remote.generation)
            }
        }
        viewModel.start(remote)
    }
}

private class ConfigLifecycleAuthActions : AccountAuthActions {
    var restoreCalls = 0
    var oauthStateCalls = 0
    var wechatLoginCalls = 0
    var qqLoginCalls = 0
    var holdNextRestore = false
    private var restoreContinuation: Continuation<AuthOutcome<LocalAuthSession?>>? = null

    val restoreIsWaiting: Boolean
        get() = restoreContinuation != null

    override suspend fun restoreSession(): AuthOutcome<LocalAuthSession?> {
        restoreCalls += 1
        if (!holdNextRestore) return AuthOutcome.Success(null)
        holdNextRestore = false
        return suspendCoroutine { restoreContinuation = it }
    }

    fun releaseRestore(outcome: AuthOutcome<LocalAuthSession?>) {
        checkNotNull(restoreContinuation).also {
            restoreContinuation = null
            it.resume(outcome)
        }
    }

    fun releaseRestoreIfNeeded(outcome: AuthOutcome<LocalAuthSession?>) {
        restoreContinuation?.also {
            restoreContinuation = null
            it.resume(outcome)
        }
    }

    override suspend fun createOAuthState(
        provider: AuthIdentityType,
        purpose: OAuthPurpose,
        phoneChallengeId: String?,
    ): AuthOutcome<OAuthStateResponse> {
        oauthStateCalls += 1
        return AuthOutcome.Success(
            OAuthStateResponse(
                provider = provider,
                purpose = purpose,
                state = AccountRemoteConfigLifecycleTest.OAUTH_STATE,
                expiresAt = AccountRemoteConfigLifecycleTest.NOW.plusSeconds(300).toString(),
            ),
        )
    }

    override suspend fun loginWithWechat(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession> {
        wechatLoginCalls += 1
        return AuthOutcome.Success(testSession())
    }

    override suspend fun loginWithQq(
        oauthState: String,
        qqAccessToken: String,
    ): AuthOutcome<LocalAuthSession> {
        qqLoginCalls += 1
        return AuthOutcome.Success(testSession())
    }

    override suspend fun identities(): AuthOutcome<List<AuthIdentityBinding>> =
        AuthOutcome.Success(emptyList())

    override suspend fun sessions(): AuthOutcome<List<AuthSessionSummary>> =
        AuthOutcome.Success(emptyList())

    override suspend fun logout(): AuthOutcome<Unit> = AuthOutcome.Success(Unit)

    override suspend fun requestPhoneCode(
        rawPhone: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> = error("unused")

    override suspend fun requestEmailCode(
        rawEmail: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> = error("unused")

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

    override suspend fun deleteAccount(): AuthOutcome<DeleteAccountResponse> = error("unused")
}

private object ConfigLifecycleNoExports : AccountExportActions {
    override suspend fun request(includeBehaviorHistory: Boolean): AccountExportOutcome<AccountExportResponse> =
        error("unused")

    override suspend fun latest(): AccountExportOutcome<AccountExportStatusResponse?> = error("unused")

    override suspend fun download(
        status: AccountExportStatusResponse,
        destinationUri: String,
    ): AccountExportOutcome<Unit> = error("unused")
}

private class ConfigLifecycleWechatFactory : WechatSdkSessionFactory {
    override val isConfigured: Boolean = true
    private val session = object : WechatSdkSession {
        override fun registerApp(): Boolean = true
        override fun isWechatInstalled(): Boolean = true
        override fun sendAuthorization(state: String): Boolean = true
        override fun handleIntent(
            intent: Intent,
            onCallback: (WechatSdkCallback) -> Unit,
        ): Boolean = true

        override fun detach() = Unit
    }

    override fun create(): WechatSdkSession = session
}

private class ConfigLifecycleQqFactory : QqSdkSessionFactory {
    override val isConfigured: Boolean = true
    var callback: ((QqSdkCallback) -> Unit)? = null

    override fun create(onCallback: (QqSdkCallback) -> Unit): QqSdkSession {
        callback = onCallback
        return object : QqSdkSession {
            override fun launchLogin(activity: Activity): Boolean = true
            override fun handleActivityResult(
                requestCode: Int,
                resultCode: Int,
                data: Intent?,
            ): Boolean = true

            override fun clear() = Unit
        }
    }

    override fun revokePrivacyConsent() = Unit
}

private class ConfigLifecycleQqHost : QqLoginHost {
    override val isAvailable: Boolean = true
    override fun launch(session: QqSdkSession): Boolean = true
}

private fun testSession() = LocalAuthSession(
    userId = "11111111-1111-4111-8111-111111111111",
    sessionId = "22222222-2222-4222-8222-222222222222",
    accessTokenExpiresAt = Instant.parse("2026-08-21T05:00:00Z"),
    refreshTokenExpiresAt = Instant.parse("2026-08-22T04:00:00Z"),
)
