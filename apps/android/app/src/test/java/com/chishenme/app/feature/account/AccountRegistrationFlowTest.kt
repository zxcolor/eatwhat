package com.chishenme.app.feature.account

import android.content.Intent
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.chishenme.app.auth.qq.QqConsentGate
import com.chishenme.app.auth.qq.QqOAuthCoordinator
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
import com.chishenme.app.data.remote.DeleteAccountResponse
import com.chishenme.app.data.remote.OAuthPurpose
import com.chishenme.app.data.remote.OAuthStateResponse
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.feature.config.RuntimeAppVersionGate
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AccountRegistrationFlowTest {
    @Test
    fun `switching entry clears an incompatible email challenge without persisting registration intent`() = withFixture {
        viewModel.selectOtpInputType(AuthIdentityType.EMAIL)
        viewModel.requestCode(AuthIdentityType.EMAIL, OtpPurpose.LOGIN, "fixture@example.com")
        runCurrent()
        assertNotNull(viewModel.state.value.challenge)

        viewModel.showRegistration()
        runCurrent()
        assertEquals(AccountEntryMode.REGISTER, viewModel.state.value.entryMode)
        assertEquals(AuthIdentityType.PHONE, viewModel.state.value.otpInputType)
        assertNull(viewModel.state.value.challenge)
        viewModel.updateOtpTargetDraft(AuthIdentityType.PHONE, PHONE)
        viewModel.showLogin()
        assertEquals("", viewModel.state.value.otpTargetDraft)
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        assertTrue(savedState.keys().none { it.contains("registration", ignoreCase = true) })
        assertTrue(savedState.keys().none { savedState.get<Any>(it)?.toString()?.contains(PHONE) == true })
    }

    @Test
    fun `entry cannot switch during a request or after authentication`() = withFixture {
        val response = CompletableDeferred<AuthOutcome<AuthCodeChallenge>>()
        auth.nextCode = response
        viewModel.requestCode(AuthIdentityType.PHONE, OtpPurpose.REGISTER, PHONE)
        runCurrent()
        assertTrue(viewModel.state.value.busy)
        viewModel.showRegistration()
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        response.complete(AuthOutcome.Success(phoneChallenge()))
        runCurrent()
        viewModel.submitLoginCode(OTP)
        runCurrent()
        viewModel.showRegistration()
        assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
    }

    @Test
    fun `registration has a real session while waiting for trusted identities and retries failed identity reads`() = withFixture {
        val identities = CompletableDeferred<AuthOutcome<List<AuthIdentityBinding>>>()
        auth.nextIdentities = identities
        enterRegistration()
        assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
        assertNotNull(auth.localSession)
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)
        assertFalse(viewModel.state.value.identitiesLoaded)

        identities.complete(AuthOutcome.Failure(AuthFailureKind.NETWORK, "测试身份请求失败"))
        runCurrent()
        assertFalse(viewModel.state.value.identitiesLoaded)
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)

        viewModel.refreshSecurityData()
        runCurrent()
        assertTrue(viewModel.state.value.identitiesLoaded)
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)
        auth.identityItems = listOf(phoneBinding(), wechatBinding())
        viewModel.refreshSecurityData()
        runCurrent()
        assertEquals(AccountRegistrationStep.SUCCESS, viewModel.state.value.registrationStep)
        assertEquals(0, auth.wechatBindCalls)
    }

    @Test
    fun `ordinary phone login never becomes a registration flow even with a bound wechat identity`() = withFixture {
        auth.identityItems = listOf(phoneBinding(), wechatBinding())
        viewModel.requestCode(AuthIdentityType.PHONE, OtpPurpose.REGISTER, PHONE)
        runCurrent()
        viewModel.submitLoginCode(OTP)
        runCurrent()
        assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        assertEquals(AccountRegistrationStep.PHONE, viewModel.state.value.registrationStep)
    }

    @Test
    fun `wechat sdk callback alone cannot complete registration until binding reaches the server`() = withFixture {
        enterRegistration()
        val binding = CompletableDeferred<AuthOutcome<AuthIdentityBinding>>()
        auth.nextBind = binding
        authorizeWechat()
        assertEquals(listOf(OAuthPurpose.BIND), auth.oauthPurposes)
        assertEquals(1, auth.wechatBindCalls)
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)

        binding.complete(AuthOutcome.Success(wechatBinding()))
        runCurrent()
        assertEquals(AccountRegistrationStep.SUCCESS, viewModel.state.value.registrationStep)
        assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
    }

    @Test
    fun `cancel timeout and binding rejection keep the existing phone session and never claim completion`() = withFixture {
        enterRegistration()
        viewModel.startWechatBind()
        runCurrent()
        wechat.acceptSdkCallback(WechatSdkCallback.Cancelled)
        runCurrent()
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)
        assertEquals(0, auth.wechatBindCalls)

        viewModel.startWechatBind()
        runCurrent()
        advanceTimeBy(90_001)
        runCurrent()
        assertFalse(viewModel.state.value.busy)
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)

        auth.bindOutcome = AuthOutcome.Failure(AuthFailureKind.CONFLICT, "测试微信已属于其他账号")
        authorizeWechat()
        assertEquals(1, auth.wechatBindCalls)
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)
        assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
        assertNotNull(auth.localSession)
    }

    @Test
    fun `leaving optional registration during binding preserves the session and does not reopen the flow`() = withFixture {
        enterRegistration()
        val binding = CompletableDeferred<AuthOutcome<AuthIdentityBinding>>()
        auth.nextBind = binding
        authorizeWechat()
        viewModel.finishRegistration()
        binding.complete(AuthOutcome.Success(wechatBinding()))
        runCurrent()
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        assertEquals(AccountRegistrationStep.PHONE, viewModel.state.value.registrationStep)
        assertEquals(AccountStatus.SIGNED_IN, viewModel.state.value.status)
        assertNotNull(auth.localSession)
        assertEquals(0, auth.logoutCalls)
    }

    @Test
    fun `temporary config refresh preserves binding flow and consumes the staged callback only when trusted`() = withFixture {
        enterRegistration()
        viewModel.startWechatBind()
        runCurrent()
        viewModel.suspendRemoteAccessForForegroundRefresh()
        wechat.acceptSdkCallback(WechatSdkCallback.Authorized(OAUTH_STATE, AUTHORIZATION_CODE))
        runCurrent()
        assertFalse(viewModel.state.value.identitiesLoaded)
        assertEquals(0, auth.wechatBindCalls)
        assertEquals(AccountEntryMode.REGISTER, viewModel.state.value.entryMode)

        viewModel.start(capabilities())
        runCurrent()
        assertEquals(1, auth.wechatBindCalls)
        assertEquals(AccountRegistrationStep.SUCCESS, viewModel.state.value.registrationStep)
    }

    @Test
    fun `logout discards the registration flow and a late wechat callback`() = withFixture {
        enterRegistration()
        viewModel.startWechatBind()
        runCurrent()
        viewModel.logout()
        runCurrent()
        wechat.acceptSdkCallback(WechatSdkCallback.Authorized(OAUTH_STATE, AUTHORIZATION_CODE))
        runCurrent()
        assertEquals(AccountStatus.GUEST, viewModel.state.value.status)
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        assertEquals(AccountRegistrationStep.PHONE, viewModel.state.value.registrationStep)
        assertFalse(viewModel.state.value.identitiesLoaded)
        assertEquals(0, auth.wechatBindCalls)
        assertNull(auth.localSession)
    }

    @Test
    fun `privacy withdrawal clears registration state instead of turning an interrupted bind into success`() = withFixture {
        enterRegistration()
        viewModel.startWechatBind()
        runCurrent()
        wechat.revokePrivacyConsent()
        runCurrent()
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        assertEquals(AccountRegistrationStep.PHONE, viewModel.state.value.registrationStep)
        assertFalse(viewModel.state.value.identitiesLoaded)
        assertEquals(0, auth.wechatBindCalls)
    }

    @Test
    fun `disabled wechat stays optional and revoked account capabilities clear the flow`() = withFixture {
        viewModel.start(capabilities(wechat = false))
        runCurrent()
        enterRegistration()
        viewModel.startWechatBind()
        runCurrent()
        assertEquals(0, auth.oauthPurposes.size)
        assertEquals(AccountRegistrationStep.WECHAT, viewModel.state.value.registrationStep)
        viewModel.finishRegistration()
        assertNotNull(auth.localSession)

        viewModel.logout()
        runCurrent()
        enterRegistration()
        viewModel.start(capabilities(accounts = false))
        runCurrent()
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        assertEquals(AccountRegistrationStep.PHONE, viewModel.state.value.registrationStep)
        assertFalse(viewModel.state.value.identitiesLoaded)
    }

    @Test
    fun `expired authentication does not leave a completed or actionable registration flow`() = withFixture {
        enterRegistration()
        auth.identityItems = listOf(phoneBinding(), wechatBinding())
        auth.sessionsOutcome = AuthOutcome.Failure(AuthFailureKind.UNAUTHORIZED, "测试登录已失效")
        viewModel.refreshSecurityData()
        runCurrent()
        assertEquals(AccountEntryMode.LOGIN, viewModel.state.value.entryMode)
        assertEquals(AccountRegistrationStep.PHONE, viewModel.state.value.registrationStep)
        assertFalse(viewModel.state.value.identitiesLoaded)
    }

    @Test
    fun `process recreation restores the real account but never restores a registration celebration`() = withFixture {
        auth.identityItems = listOf(phoneBinding(), wechatBinding())
        enterRegistration()
        assertEquals(AccountRegistrationStep.SUCCESS, viewModel.state.value.registrationStep)
        runCurrent()
        val recreated = RegistrationFixture(auth, savedState)
        try {
            recreated.viewModel.start(capabilities())
            runCurrent()
            assertEquals(AccountStatus.SIGNED_IN, recreated.viewModel.state.value.status)
            assertEquals(AccountEntryMode.LOGIN, recreated.viewModel.state.value.entryMode)
            assertEquals(AccountRegistrationStep.PHONE, recreated.viewModel.state.value.registrationStep)
        } finally {
            recreated.viewModel.viewModelScope.cancel()
        }
    }

    private fun withFixture(block: suspend RegistrationTestContext.() -> Unit) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val fixture = RegistrationFixture()
        try {
            fixture.viewModel.start(capabilities())
            runCurrent()
            RegistrationTestContext(this, fixture).block()
        } finally {
            fixture.viewModel.viewModelScope.cancel()
            runCurrent()
            Dispatchers.resetMain()
        }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
private class RegistrationTestContext(
    private val scope: TestScope,
    private val fixture: RegistrationFixture,
) {
    val viewModel get() = fixture.viewModel
    val auth get() = fixture.auth
    val wechat get() = fixture.wechat
    val savedState get() = fixture.savedState

    fun runCurrent() = scope.runCurrent()
    fun advanceTimeBy(millis: Long) = scope.advanceTimeBy(millis)

    fun enterRegistration() {
        viewModel.showRegistration()
        viewModel.requestCode(AuthIdentityType.PHONE, OtpPurpose.REGISTER, PHONE)
        runCurrent()
        viewModel.submitLoginCode(OTP)
        runCurrent()
    }

    fun authorizeWechat() {
        viewModel.startWechatBind()
        runCurrent()
        wechat.acceptSdkCallback(WechatSdkCallback.Authorized(OAUTH_STATE, AUTHORIZATION_CODE))
        runCurrent()
    }
}

private class RegistrationFixture(
    val auth: RegistrationAuthActions = RegistrationAuthActions(),
    val savedState: SavedStateHandle = SavedStateHandle(),
) {
    val wechat = WechatOAuthManager(
        consentGate = WechatConsentGate { true },
        sessionFactory = RegistrationWechatFactory,
        coordinator = WechatOAuthCoordinator { FIXTURE_NOW },
    )
    private val qq = QqOAuthManager(
        consentGate = QqConsentGate { true },
        sessionFactory = object : QqSdkSessionFactory {
            override val isConfigured = false
            override fun create(onCallback: (QqSdkCallback) -> Unit): QqSdkSession = error("QQ is not used")
            override fun revokePrivacyConsent() = Unit
        },
        coordinator = QqOAuthCoordinator { FIXTURE_NOW },
    )
    val viewModel = AccountViewModel(
        repository = auth,
        exportRepository = RegistrationNoExports,
        wechatOAuth = wechat,
        qqOAuth = qq,
        runtimeAppVersionGate = RuntimeAppVersionGate("0.1.0"),
        savedStateHandle = savedState,
    )
}

private class RegistrationAuthActions : AccountAuthActions {
    var localSession: LocalAuthSession? = null
    var identityItems = listOf(phoneBinding())
    var sessionsOutcome: AuthOutcome<List<AuthSessionSummary>> = AuthOutcome.Success(emptyList())
    var bindOutcome: AuthOutcome<AuthIdentityBinding> = AuthOutcome.Success(wechatBinding())
    var nextCode: CompletableDeferred<AuthOutcome<AuthCodeChallenge>>? = null
    var nextIdentities: CompletableDeferred<AuthOutcome<List<AuthIdentityBinding>>>? = null
    var nextBind: CompletableDeferred<AuthOutcome<AuthIdentityBinding>>? = null
    var wechatBindCalls = 0
    var logoutCalls = 0
    val oauthPurposes = mutableListOf<OAuthPurpose>()

    override suspend fun restoreSession(): AuthOutcome<LocalAuthSession?> = AuthOutcome.Success(localSession)

    override suspend fun requestPhoneCode(rawPhone: String, purpose: OtpPurpose): AuthOutcome<AuthCodeChallenge> =
        nextCode.also { nextCode = null }?.await() ?: AuthOutcome.Success(phoneChallenge())

    override suspend fun requestEmailCode(rawEmail: String, purpose: OtpPurpose): AuthOutcome<AuthCodeChallenge> =
        AuthOutcome.Success(phoneChallenge().copy(targetType = AuthIdentityType.EMAIL, maskedTarget = "f***@example.com"))

    override suspend fun loginWithOtp(
        type: AuthIdentityType,
        challengeId: String,
        otpCode: String,
        phoneNumber: String?,
    ): AuthOutcome<LocalAuthSession> = AuthOutcome.Success(
        LocalAuthSession(
            userId = "11111111-1111-4111-8111-111111111111",
            sessionId = "22222222-2222-4222-8222-222222222222",
            accessTokenExpiresAt = FIXTURE_NOW.plusSeconds(300),
            refreshTokenExpiresAt = FIXTURE_NOW.plusSeconds(3_600),
        ).also { localSession = it },
    )

    override suspend fun createOAuthState(provider: AuthIdentityType, purpose: OAuthPurpose): AuthOutcome<OAuthStateResponse> {
        oauthPurposes += purpose
        return AuthOutcome.Success(OAuthStateResponse(provider, purpose, OAUTH_STATE, FIXTURE_NOW.plusSeconds(300).toString()))
    }

    override suspend fun identities(): AuthOutcome<List<AuthIdentityBinding>> =
        nextIdentities.also { nextIdentities = null }?.await() ?: AuthOutcome.Success(identityItems)

    override suspend fun sessions(): AuthOutcome<List<AuthSessionSummary>> = sessionsOutcome

    override suspend fun bindWithWechat(oauthState: String, authorizationCode: String): AuthOutcome<AuthIdentityBinding> {
        wechatBindCalls += 1
        val outcome = nextBind.also { nextBind = null }?.await() ?: bindOutcome
        if (outcome is AuthOutcome.Success) identityItems = listOf(phoneBinding(), outcome.value)
        return outcome
    }

    override suspend fun logout(): AuthOutcome<Unit> {
        logoutCalls += 1
        localSession = null
        return AuthOutcome.Success(Unit)
    }

    override suspend fun loginWithWechat(oauthState: String, authorizationCode: String): AuthOutcome<LocalAuthSession> = error("unused")
    override suspend fun loginWithQq(oauthState: String, authorizationCode: String): AuthOutcome<LocalAuthSession> = error("unused")
    override suspend fun bindWithOtp(type: AuthIdentityType, challengeId: String, otpCode: String): AuthOutcome<AuthIdentityBinding> = error("unused")
    override suspend fun bindWithQq(oauthState: String, authorizationCode: String): AuthOutcome<AuthIdentityBinding> = error("unused")
    override suspend fun unbindIdentity(bindingId: String): AuthOutcome<Unit> = error("unused")
    override suspend fun revokeSession(sessionId: String): AuthOutcome<Unit> = error("unused")
    override suspend fun deleteAccount(): AuthOutcome<DeleteAccountResponse> = error("unused")
}

private object RegistrationWechatFactory : WechatSdkSessionFactory {
    override val isConfigured = true
    override fun create(): WechatSdkSession = object : WechatSdkSession {
        override fun registerApp() = true
        override fun isWechatInstalled() = true
        override fun sendAuthorization(state: String) = true
        override fun handleIntent(intent: Intent, onCallback: (WechatSdkCallback) -> Unit) = true
        override fun detach() = Unit
    }
}

private object RegistrationNoExports : AccountExportActions {
    override suspend fun request(includeBehaviorHistory: Boolean): AccountExportOutcome<AccountExportResponse> = error("unused")
    override suspend fun latest(): AccountExportOutcome<AccountExportStatusResponse?> = error("unused")
    override suspend fun download(status: AccountExportStatusResponse, destinationUri: String): AccountExportOutcome<Unit> = error("unused")
}

private fun capabilities(accounts: Boolean = true, wechat: Boolean = true) = AuthCapabilities(
    accountsEnabled = accounts,
    registrationEnabled = accounts,
    phoneEnabled = accounts,
    wechatEnabled = accounts && wechat,
    emailEnabled = accounts,
    qqEnabled = false,
    dataExportEnabled = false,
)

private fun phoneChallenge() = AuthCodeChallenge(
    challengeId = "33333333-3333-4333-8333-333333333333",
    targetType = AuthIdentityType.PHONE,
    maskedTarget = "+86138****8000",
    expiresAt = Instant.now().plusSeconds(300).toString(),
    resendAvailableAt = Instant.now().plusSeconds(60).toString(),
)

private fun phoneBinding() = AuthIdentityBinding(
    "44444444-4444-4444-8444-444444444444", AuthIdentityType.PHONE,
    "+86138****8000", FIXTURE_NOW.toString(), primary = true, canUnbind = false,
)

private fun wechatBinding() = AuthIdentityBinding(
    "55555555-5555-4555-8555-555555555555", AuthIdentityType.WECHAT,
    "测试微信", FIXTURE_NOW.toString(), primary = false, canUnbind = true,
)

private val FIXTURE_NOW = Instant.parse("2026-09-16T04:00:00Z")
private const val PHONE = "+8613800138000"
private const val OTP = "123456"
private const val OAUTH_STATE = "sssssssssssssssssssssssssssssssssssssssssss"
private const val AUTHORIZATION_CODE = "synthetic-wechat-authorization-code"
