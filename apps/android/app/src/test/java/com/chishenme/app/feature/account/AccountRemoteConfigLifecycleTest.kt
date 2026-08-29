package com.chishenme.app.feature.account

import android.app.Activity
import android.content.Intent
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
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
import com.chishenme.app.data.AuthFailureKind
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
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
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
    fun `process recreation restores only challenge metadata and requires phone resend`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var firstForCleanup: ConfigLifecycleFixture? = null
        var recreatedForCleanup: ConfigLifecycleFixture? = null
        try {
            val savedState = SavedStateHandle()
            val firstAuth = ConfigLifecycleAuthActions()
            val first = fixture(firstAuth, savedState)
            firstForCleanup = first
            first.start(ready(1, capabilities(registration = true)))
            runCurrent()
            first.viewModel.requestCode(
                AuthIdentityType.PHONE,
                OtpPurpose.REGISTER,
                PHONE_NUMBER,
            )
            runCurrent()
            first.viewModel.updateOtpCodeDraft("123456")
            assertFalse(first.viewModel.state.value.toString().contains(PHONE_NUMBER))
            assertFalse(first.viewModel.state.value.toString().contains("123456"))

            assertTrue(
                savedState.keys().none { key ->
                    val value = savedState.get<Any>(key)?.toString().orEmpty()
                    value.contains(PHONE_NUMBER) || value.contains("123456")
                },
            )
            first.viewModel.viewModelScope.cancel()
            runCurrent()

            val recreatedAuth = ConfigLifecycleAuthActions()
            val recreated = fixture(recreatedAuth, savedState)
            recreatedForCleanup = recreated
            recreated.start(ready(1, capabilities(registration = true)))
            runCurrent()
            assertEquals(AccountAuthStep.PHONE_REGISTER, recreated.viewModel.state.value.authStep)
            assertEquals(PHONE_CHALLENGE_ID, recreated.viewModel.state.value.challenge?.challengeId)
            assertEquals("", recreated.viewModel.state.value.otpTargetDraft)
            assertEquals("", recreated.viewModel.state.value.otpCodeDraft)

            recreated.viewModel.submitLoginCode("123456")
            runCurrent()

            assertEquals(0, recreatedAuth.phoneLoginCalls)
            assertEquals("为保护手机号，App 重启后需重新发送验证码", recreated.viewModel.state.value.message)
        } finally {
            firstForCleanup?.viewModel?.viewModelScope?.cancel()
            recreatedForCleanup?.viewModel?.viewModelScope?.cancel()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

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

            fixture.start(ready(2, capabilities(wechat = false)))
            runCurrent()
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `wechat authorization without a callback times out and can be started again`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val auth = ConfigLifecycleAuthActions()
            val fixture = fixture(auth)
            fixture.start(ready(1, capabilities(wechat = true)))
            runCurrent()

            fixture.viewModel.startWechatLogin()
            runCurrent()
            assertEquals(1, auth.oauthStateCalls)
            assertTrue(fixture.viewModel.state.value.busy)

            advanceTimeBy(90_000L)
            runCurrent()
            assertFalse(fixture.viewModel.state.value.busy)
            assertEquals(AccountAuthStep.CHOOSE, fixture.viewModel.state.value.authStep)
            assertEquals("微信授权已超时，请重新发起", fixture.viewModel.state.value.message)

            fixture.viewModel.startWechatLogin()
            runCurrent()
            assertEquals(2, auth.oauthStateCalls)

            fixture.start(ready(2, capabilities(wechat = false)))
            runCurrent()
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
    fun `qq server side authorization code reaches repository once without becoming UI state`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var fixtureForCleanup: ConfigLifecycleFixture? = null
        try {
            val auth = ConfigLifecycleAuthActions()
            val fixture = fixture(auth)
            fixtureForCleanup = fixture
            fixture.start(ready(1, capabilities(qq = true)))
            runCurrent()
            fixture.viewModel.startQqLogin(ConfigLifecycleQqHost())
            runCurrent()
            val callback = requireNotNull(fixture.qqFactory.callback)

            callback(QqSdkCallback.Authorized(QQ_AUTHORIZATION_CODE))
            runCurrent()

            assertEquals(1, auth.qqLoginCalls)
            assertEquals(QQ_AUTHORIZATION_CODE, auth.lastQqAuthorizationCode)
            assertFalse(fixture.viewModel.state.value.toString().contains(QQ_AUTHORIZATION_CODE))

            callback(QqSdkCallback.Authorized(QQ_AUTHORIZATION_CODE))
            runCurrent()
            assertEquals(1, auth.qqLoginCalls)
        } finally {
            fixtureForCleanup?.viewModel?.viewModelScope?.cancel()
            runCurrent()
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
            fixture.qqFactory.callback?.invoke(QqSdkCallback.Authorized(QQ_AUTHORIZATION_CODE))
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

    @Test
    fun `qq authorization times out and a late provider callback stays discarded`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var fixtureForCleanup: ConfigLifecycleFixture? = null
        try {
            val auth = ConfigLifecycleAuthActions()
            val fixture = fixture(auth)
            fixtureForCleanup = fixture
            fixture.start(ready(1, capabilities(qq = true)))
            runCurrent()
            fixture.viewModel.startQqLogin(ConfigLifecycleQqHost())
            runCurrent()
            val lateCallback = requireNotNull(fixture.qqFactory.callback)

            advanceTimeBy(89_999)
            runCurrent()
            assertTrue(fixture.viewModel.state.value.busy)
            assertEquals(AccountAuthStep.QQ_LOGIN, fixture.viewModel.state.value.authStep)
            assertNull(fixture.viewModel.state.value.message)

            advanceTimeBy(1)
            runCurrent()

            assertFalse(fixture.viewModel.state.value.busy)
            assertEquals(AccountAuthStep.CHOOSE, fixture.viewModel.state.value.authStep)
            assertEquals("QQ 授权已超时，请重新发起", fixture.viewModel.state.value.message)
            lateCallback(QqSdkCallback.Authorized(QQ_AUTHORIZATION_CODE))
            runCurrent()
            assertEquals(0, auth.qqLoginCalls)
        } finally {
            fixtureForCleanup?.viewModel?.viewModelScope?.cancel()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `qq bind callback from a logged out account epoch cannot reach the repository`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var fixtureForCleanup: ConfigLifecycleFixture? = null
        try {
            val auth = ConfigLifecycleAuthActions().apply { restoredSession = testSession() }
            val fixture = fixture(auth)
            fixtureForCleanup = fixture
            fixture.start(ready(1, capabilities(qq = true)))
            runCurrent()
            assertEquals(AccountStatus.SIGNED_IN, fixture.viewModel.state.value.status)
            fixture.viewModel.startQqBind(ConfigLifecycleQqHost())
            runCurrent()
            val staleCallback = requireNotNull(fixture.qqFactory.callback)

            fixture.viewModel.logout()
            runCurrent()
            staleCallback(QqSdkCallback.Authorized(QQ_AUTHORIZATION_CODE))
            runCurrent()

            assertEquals(0, auth.qqBindCalls)
            assertEquals(AccountStatus.GUEST, fixture.viewModel.state.value.status)
        } finally {
            fixtureForCleanup?.viewModel?.viewModelScope?.cancel()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `process recreation never restores a QQ authorization screen without its memory proof`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val fixtures = mutableListOf<ConfigLifecycleFixture>()
        try {
            listOf(AccountAuthStep.QQ_LOGIN, AccountAuthStep.BIND_QQ).forEach { step ->
                val fixture = fixture(
                    ConfigLifecycleAuthActions(),
                    SavedStateHandle(mapOf("account.auth.step" to step.name)),
                )
                fixtures += fixture
                assertEquals(AccountAuthStep.CHOOSE, fixture.viewModel.state.value.authStep)
            }
        } finally {
            fixtures.forEach { it.viewModel.viewModelScope.cancel() }
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `signed in foreground refresh reloads identities and sessions`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val emailBinding = testEmailBinding()
            val session = testSessionSummary()
            val auth = ConfigLifecycleAuthActions().apply {
                restoredSession = testSession()
                identityItems = listOf(emailBinding)
                sessionItems = listOf(session)
            }
            val fixture = fixture(auth)
            val ready = ready(1, capabilities())

            fixture.start(ready)
            runCurrent()
            assertEquals(listOf(emailBinding), fixture.viewModel.state.value.identities)
            assertEquals(listOf(session), fixture.viewModel.state.value.sessions)
            assertEquals(1, auth.identitiesCalls)
            assertEquals(1, auth.sessionsCalls)

            fixture.viewModel.suspendRemoteAccessForForegroundRefresh()
            assertTrue(fixture.viewModel.state.value.identities.isEmpty())
            assertTrue(fixture.viewModel.state.value.sessions.isEmpty())
            fixture.start(ready)
            runCurrent()

            assertEquals(listOf(emailBinding), fixture.viewModel.state.value.identities)
            assertEquals(listOf(session), fixture.viewModel.state.value.sessions)
            assertEquals(2, auth.identitiesCalls)
            assertEquals(2, auth.sessionsCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `guest restore clears a persisted email bind challenge`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val now = Instant.now()
            val savedState = SavedStateHandle(
                mapOf(
                    "account.auth.step" to AccountAuthStep.BIND_EMAIL.name,
                    "account.challenge.type" to AuthIdentityType.EMAIL.name,
                    "account.challenge.purpose" to OtpPurpose.BIND.name,
                    "account.challenge.id" to EMAIL_CHALLENGE_ID,
                    "account.challenge.mask" to "u****r@example.com",
                    "account.challenge.expiresAt" to now.plusSeconds(300).toString(),
                    "account.challenge.resendAt" to now.plusSeconds(60).toString(),
                ),
            )
            val fixture = fixture(ConfigLifecycleAuthActions(), savedState)

            fixture.start(ready(1, capabilities()))
            runCurrent()

            assertEquals(AccountStatus.GUEST, fixture.viewModel.state.value.status)
            assertNull(fixture.viewModel.state.value.challenge)
            assertEquals(AccountAuthStep.CHOOSE, fixture.viewModel.state.value.authStep)
            fixture.viewModel.updateOtpTargetDraft(AuthIdentityType.EMAIL, EMAIL_ADDRESS)
            assertEquals(EMAIL_ADDRESS, fixture.viewModel.state.value.otpTargetDraft)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `failed session restore also clears a persisted email bind challenge`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val now = Instant.now()
            val savedState = SavedStateHandle(
                mapOf(
                    "account.auth.step" to AccountAuthStep.BIND_EMAIL.name,
                    "account.challenge.type" to AuthIdentityType.EMAIL.name,
                    "account.challenge.purpose" to OtpPurpose.BIND.name,
                    "account.challenge.id" to EMAIL_CHALLENGE_ID,
                    "account.challenge.mask" to "u****r@example.com",
                    "account.challenge.expiresAt" to now.plusSeconds(300).toString(),
                    "account.challenge.resendAt" to now.plusSeconds(60).toString(),
                ),
            )
            val auth = ConfigLifecycleAuthActions().apply {
                restoreOutcome = AuthOutcome.Failure(AuthFailureKind.NETWORK, "账号服务暂不可用")
            }
            val fixture = fixture(auth, savedState)

            fixture.start(ready(1, capabilities()))
            runCurrent()

            assertEquals(AccountStatus.GUEST, fixture.viewModel.state.value.status)
            assertNull(fixture.viewModel.state.value.challenge)
            assertEquals(AccountAuthStep.CHOOSE, fixture.viewModel.state.value.authStep)
            assertEquals("账号服务暂不可用", fixture.viewModel.state.value.message)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `email resend is explicit cooldown bound and expiry clears the proof`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var fixtureForCleanup: ConfigLifecycleFixture? = null
        try {
            val auth = ConfigLifecycleAuthActions()
            val savedState = SavedStateHandle()
            val fixture = fixture(auth, savedState)
            fixtureForCleanup = fixture
            fixture.start(ready(1, capabilities()))
            runCurrent()
            fixture.viewModel.updateOtpTargetDraft(AuthIdentityType.EMAIL, EMAIL_ADDRESS)
            fixture.viewModel.requestCode(AuthIdentityType.EMAIL, OtpPurpose.LOGIN, EMAIL_ADDRESS)
            runCurrent()
            fixture.viewModel.updateOtpCodeDraft("123456")
            runCurrent()

            val first = requireNotNull(fixture.viewModel.state.value.challenge)
            assertEquals(1, auth.emailCodeCalls)
            assertTrue(fixture.viewModel.state.value.otpCanResend)
            assertTrue(
                savedState.keys().none { key ->
                    val value = savedState.get<Any>(key)?.toString().orEmpty()
                    value.contains(EMAIL_ADDRESS) || value.contains("123456")
                },
            )
            fixture.viewModel.resendCode(first.resendAvailableAt.minusMillis(1))
            runCurrent()
            assertEquals(1, auth.emailCodeCalls)

            fixture.viewModel.resendCode(first.resendAvailableAt)
            runCurrent()
            assertEquals(2, auth.emailCodeCalls)
            val resent = requireNotNull(fixture.viewModel.state.value.challenge)
            fixture.viewModel.updateOtpCodeDraft("123456")
            fixture.viewModel.refreshOtpChallengeTiming(resent.expiresAt.plusMillis(1))

            assertNull(fixture.viewModel.state.value.challenge)
            assertEquals(EMAIL_ADDRESS, fixture.viewModel.state.value.otpTargetDraft)
            assertEquals("", fixture.viewModel.state.value.otpCodeDraft)
            assertEquals("验证码已过期，请重新获取", fixture.viewModel.state.value.message)
            assertEquals(2, auth.emailCodeCalls)
        } finally {
            fixtureForCleanup?.viewModel?.viewModelScope?.cancel()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    private fun fixture(
        auth: ConfigLifecycleAuthActions,
        savedStateHandle: SavedStateHandle = SavedStateHandle(),
    ): ConfigLifecycleFixture {
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
                savedStateHandle = savedStateHandle,
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
        registration: Boolean = false,
        phone: Boolean = accounts,
        wechat: Boolean = false,
        qq: Boolean = false,
    ) = AuthCapabilities(
        accountsEnabled = accounts,
        registrationEnabled = accounts && registration,
        phoneEnabled = accounts && phone,
        wechatEnabled = accounts && wechat,
        emailEnabled = accounts,
        qqEnabled = accounts && qq,
        dataExportEnabled = false,
    )

    companion object {
        val NOW: Instant = Instant.parse("2026-08-21T04:00:00Z")
        const val OAUTH_STATE = "sssssssssssssssssssssssssssssssssssssssssss"
        const val WECHAT_CODE = "private-wechat-authorization-code"
        const val QQ_AUTHORIZATION_CODE = "private-qq-authorization-code"
        const val PHONE_NUMBER = "+8613800138000"
        const val PHONE_CHALLENGE_ID = "11111111-1111-4111-8111-111111111111"
        const val EMAIL_ADDRESS = "user@example.com"
        const val EMAIL_CHALLENGE_ID = "33333333-3333-4333-8333-333333333333"
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
    var restoredSession: LocalAuthSession? = null
    var restoreOutcome: AuthOutcome<LocalAuthSession?>? = null
    var oauthStateCalls = 0
    var wechatLoginCalls = 0
    var qqLoginCalls = 0
    var qqBindCalls = 0
    var lastQqAuthorizationCode: String? = null
    var phoneLoginCalls = 0
    var lastPhoneNumber: String? = null
    var emailCodeCalls = 0
    var identitiesCalls = 0
    var sessionsCalls = 0
    var identityItems: List<AuthIdentityBinding> = emptyList()
    var sessionItems: List<AuthSessionSummary> = emptyList()
    var holdNextRestore = false
    private var restoreContinuation: Continuation<AuthOutcome<LocalAuthSession?>>? = null

    val restoreIsWaiting: Boolean
        get() = restoreContinuation != null

    override suspend fun restoreSession(): AuthOutcome<LocalAuthSession?> {
        restoreCalls += 1
        if (!holdNextRestore) return restoreOutcome ?: AuthOutcome.Success(restoredSession)
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
        authorizationCode: String,
    ): AuthOutcome<LocalAuthSession> {
        qqLoginCalls += 1
        lastQqAuthorizationCode = authorizationCode
        return AuthOutcome.Success(testSession())
    }

    override suspend fun identities(): AuthOutcome<List<AuthIdentityBinding>> {
        identitiesCalls += 1
        return AuthOutcome.Success(identityItems)
    }

    override suspend fun sessions(): AuthOutcome<List<AuthSessionSummary>> {
        sessionsCalls += 1
        return AuthOutcome.Success(sessionItems)
    }

    override suspend fun logout(): AuthOutcome<Unit> = AuthOutcome.Success(Unit)

    override suspend fun requestPhoneCode(
        rawPhone: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> = AuthOutcome.Success(
        AuthCodeChallenge(
            challengeId = AccountRemoteConfigLifecycleTest.PHONE_CHALLENGE_ID,
            targetType = AuthIdentityType.PHONE,
            maskedTarget = "+86 138****8000",
            expiresAt = Instant.now().plusSeconds(300).toString(),
            resendAvailableAt = Instant.now().plusSeconds(60).toString(),
        ),
    )

    override suspend fun requestEmailCode(
        rawEmail: String,
        purpose: OtpPurpose,
    ): AuthOutcome<AuthCodeChallenge> {
        emailCodeCalls += 1
        val now = Instant.now()
        return AuthOutcome.Success(
            AuthCodeChallenge(
                challengeId = AccountRemoteConfigLifecycleTest.EMAIL_CHALLENGE_ID,
                targetType = AuthIdentityType.EMAIL,
                maskedTarget = "u****r@example.com",
                expiresAt = now.plusSeconds(300).toString(),
                resendAvailableAt = now.plusSeconds(60).toString(),
            ),
        )
    }

    override suspend fun loginWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
        phoneNumber: String?,
    ): AuthOutcome<LocalAuthSession> {
        phoneLoginCalls += 1
        lastPhoneNumber = phoneNumber
        return AuthOutcome.Success(testSession())
    }

    override suspend fun bindWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
    ): AuthOutcome<AuthIdentityBinding> = error("unused")

    override suspend fun bindWithQq(
        oauthState: String,
        authorizationCode: String,
    ): AuthOutcome<AuthIdentityBinding> {
        qqBindCalls += 1
        lastQqAuthorizationCode = authorizationCode
        return AuthOutcome.Success(testQqBinding())
    }

    override suspend fun bindWithWechat(
        oauthState: String,
        authorizationCode: String,
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

private fun testEmailBinding() = AuthIdentityBinding(
    bindingId = "33333333-3333-4333-8333-333333333333",
    type = AuthIdentityType.EMAIL,
    maskedValue = "u****r@example.com",
    boundAt = "2026-08-21T04:00:00Z",
    primary = false,
    canUnbind = true,
)

private fun testQqBinding() = AuthIdentityBinding(
    bindingId = "44444444-4444-4444-8444-444444444444",
    type = AuthIdentityType.QQ,
    maskedValue = "QQ 账号",
    boundAt = "2026-08-21T04:00:00Z",
    primary = false,
    canUnbind = true,
)

private fun testSessionSummary() = AuthSessionSummary(
    sessionId = "22222222-2222-4222-8222-222222222222",
    deviceLabel = "Android 设备",
    platform = "ANDROID",
    current = true,
    createdAt = "2026-08-21T04:00:00Z",
    lastActiveAt = "2026-08-21T04:00:00Z",
    expiresAt = "2026-08-22T04:00:00Z",
)
