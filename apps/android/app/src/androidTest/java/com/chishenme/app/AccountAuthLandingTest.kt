package com.chishenme.app

import androidx.activity.compose.setContent
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.chishenme.app.data.local.ThemePreference
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.AuthIdentityType
import com.chishenme.app.data.remote.OtpPurpose
import com.chishenme.app.feature.account.AccountAuthLanding
import com.chishenme.app.feature.account.AccountEntryMode
import com.chishenme.app.feature.account.AccountRegistrationStep
import com.chishenme.app.feature.account.AccountStatus
import com.chishenme.app.feature.account.AccountUiState
import com.chishenme.app.feature.account.AuthLandingActions
import com.chishenme.app.feature.account.PendingOtpChallenge
import com.chishenme.app.ui.theme.ChiShenMeTheme
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Native presentation checks with synthetic state and recording callbacks, never provider SDKs. */
@RunWith(AndroidJUnit4::class)
class AccountAuthLandingTest {
    @get:Rule val composeRule = createEmptyComposeRule()

    @Test
    fun phoneAndEmail_sharePositionsAndExposeIconActionsWithoutVisibleNames() = withAuth { harness ->
        composeRule.onNodeWithTag("auth-title").assertTextEquals("登录")
        composeRule.onNodeWithContentDescription("手机号").assertIsDisplayed()
        assertIconOnlyActions("邮箱登录")
        assertBottomPlacement()
        val phoneBounds = alignedTags.associateWith(::bounds)
        composeRule.captureUiRefinementScreenshot("auth-login-phone.png")

        composeRule.onNodeWithContentDescription("邮箱登录").performClick()
        composeRule.onNodeWithContentDescription("邮箱地址").assertIsDisplayed()
        assertIconOnlyActions("手机号登录")
        alignedTags.forEach { tag -> assertSameBounds(tag, phoneBounds.getValue(tag), bounds(tag)) }
        assertBottomPlacement()
        composeRule.captureUiRefinementScreenshot("auth-login-email.png")
        composeRule.onNodeWithContentDescription("手机号登录").performClick()
        composeRule.runOnIdle { assertEquals(AuthIdentityType.PHONE, harness.state.otpInputType) }
    }

    @Test
    fun consentGatesCodeRequestsSubmissionAndNativeProviders() = withAuth(
        initial = guestState().copy(otpTargetDraft = SYNTHETIC_PHONE),
    ) { harness ->
        composeRule.onNodeWithTag("auth-consent").assertIsOff()
        composeRule.onNodeWithTag("auth-send-code").assertIsNotEnabled().performClick()
        composeRule.onNodeWithTag("auth-primary").assertIsNotEnabled().performClick()
        composeRule.onNodeWithContentDescription("微信登录").performClick()
        composeRule.onNodeWithContentDescription("QQ 登录").performClick()
        composeRule.runOnIdle {
            assertEquals(0, harness.requestCodes)
            assertEquals(0, harness.submissions)
            assertEquals(0, harness.wechatLogins)
            assertEquals(0, harness.qqLogins)
            assertEquals(List(2) { "请先阅读并同意隐私政策" }, harness.notices)
        }

        composeRule.onNodeWithTag("auth-consent").performClick().assertIsOn()
        composeRule.onNodeWithTag("auth-send-code").assertIsEnabled().performClick()
        composeRule.onNodeWithContentDescription("微信登录").performClick()
        composeRule.onNodeWithContentDescription("QQ 登录").performClick()
        composeRule.runOnIdle {
            assertEquals(1, harness.requestCodes)
            assertEquals(1, harness.wechatLogins)
            assertEquals(1, harness.qqLogins)
            harness.state = harness.state.copy(
                challenge = syntheticChallenge(),
                otpCodeDraft = "123456",
                otpSecondsUntilExpiry = 300,
                otpSecondsUntilResend = 0,
                otpCanResend = true,
            )
        }
        composeRule.onNodeWithTag("auth-primary").performScrollTo().assertIsEnabled().performClick()
        composeRule.onNodeWithTag("auth-consent").performScrollTo().performClick().assertIsOff()
        composeRule.onNodeWithTag("auth-primary").performScrollTo().assertIsNotEnabled().performClick()
        composeRule.onNodeWithTag("auth-send-code").performScrollTo().assertIsNotEnabled().performClick()
        composeRule.runOnIdle {
            assertEquals(1, harness.submissions)
            assertEquals(0, harness.resends)
        }
    }

    @Test
    fun unavailableNativeProvidersKeepIconsButNeverDispatchAuthentication() = withAuth(
        initial = guestState().copy(wechatClientConfigured = false, qqClientConfigured = false),
    ) { harness ->
        composeRule.onNodeWithTag("auth-consent").performClick()
        listOf("auth-wechat", "auth-qq").forEach { tag ->
            composeRule.onNodeWithTag(tag)
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "暂不可用"))
                .performClick()
        }
        composeRule.runOnIdle {
            assertEquals(0, harness.wechatLogins)
            assertEquals(0, harness.qqLogins)
            assertEquals(
                listOf("当前安装包暂不支持微信登录", "当前安装包暂不支持 QQ 登录"),
                harness.notices,
            )
        }
    }

    @Test
    fun registrationProgressFollowsPresentedSessionStateAndRequiresConsentToBind() = withAuth { harness ->
        composeRule.onNodeWithTag("auth-switch-mode").performClick()
        composeRule.onNodeWithTag("auth-title").assertTextEquals("注册")
        assertProgress(AccountRegistrationStep.PHONE)
        composeRule.onNodeWithText("已有账号？").assertIsDisplayed()
        composeRule.onNodeWithTag("auth-primary").assertTextEquals("下一步")
        composeRule.onNodeWithTag("auth-wechat").assertDoesNotExist()
        assertPrivacyBelowPrimary()
        composeRule.captureUiRefinementScreenshot("auth-register-phone.png")

        // A progress hint alone cannot show completed registration before a real signed-in state.
        composeRule.runOnIdle { harness.state = harness.state.copy(registrationStep = AccountRegistrationStep.SUCCESS) }
        assertProgress(AccountRegistrationStep.PHONE)
        composeRule.onNodeWithText("已完成手机号验证与微信绑定").assertDoesNotExist()
        composeRule.runOnIdle {
            harness.state = harness.state.copy(
                status = AccountStatus.SIGNED_IN,
                identitiesLoaded = true,
                registrationStep = AccountRegistrationStep.WECHAT,
            )
        }
        assertProgress(AccountRegistrationStep.WECHAT)
        composeRule.onNodeWithText("手机号已验证").assertIsDisplayed()
        composeRule.onNodeWithText("已有账号？").assertDoesNotExist()
        composeRule.onNodeWithTag("auth-switch-mode").assertDoesNotExist()
        composeRule.onNodeWithTag("auth-primary").assertTextEquals("绑定微信").assertIsNotEnabled()
        composeRule.onNodeWithTag("auth-consent").assertIsOff()
        assertPrivacyBelowPrimary()
        composeRule.captureUiRefinementScreenshot("auth-register-wechat.png")
        composeRule.onNodeWithTag("auth-primary").performClick()
        composeRule.runOnIdle { assertEquals(0, harness.wechatBindings) }
        composeRule.onNodeWithTag("auth-consent").performClick().assertIsOn()
        composeRule.onNodeWithTag("auth-primary").assertIsEnabled().performClick()
        composeRule.runOnIdle { assertEquals(1, harness.wechatBindings) }
        assertProgress(AccountRegistrationStep.WECHAT)

        composeRule.runOnIdle { harness.state = harness.state.copy(registrationStep = AccountRegistrationStep.SUCCESS) }
        assertProgress(AccountRegistrationStep.SUCCESS)
        composeRule.onNodeWithText("已完成手机号验证与微信绑定").assertIsDisplayed()
        composeRule.onNodeWithTag("auth-primary").assertTextEquals("开始使用").assertIsEnabled()
        composeRule.captureUiRefinementScreenshot("auth-register-success.png")
        composeRule.onNodeWithTag("auth-primary").performClick()
        composeRule.runOnIdle { assertEquals(1, harness.finishes) }
    }

    @Test
    fun darkLargeTextKeepsFieldsPrivacyAndAlternativeActionsReachable() = withAuth(largeText = true) { harness ->
        listOf("auth-title", "auth-target", "auth-code", "auth-send-code", "auth-primary", "auth-consent")
            .forEach { tag -> composeRule.onNodeWithTag(tag).performScrollTo().assertIsDisplayed() }
        composeRule.onNodeWithText("《隐私政策》").performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("auth-switch-channel").performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithContentDescription("邮箱地址").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("auth-consent").performScrollTo().performClick().assertIsOn()
        composeRule.onNodeWithTag("auth-wechat").performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("auth-qq").performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("auth-title").performScrollTo()
        composeRule.captureUiRefinementScreenshot("auth-dark-large-text.png")
        composeRule.runOnIdle {
            assertEquals(1, harness.privacyOpens)
            assertEquals(1, harness.wechatLogins)
            assertEquals(1, harness.qqLogins)
            assertEquals(AuthIdentityType.EMAIL, harness.state.otpInputType)
        }
    }

    private fun assertIconOnlyActions(channelDescription: String) {
        listOf("微信登录", "QQ 登录", channelDescription).forEach {
            composeRule.onNodeWithContentDescription(it).assertIsDisplayed().assertIsEnabled()
            composeRule.onNodeWithText(it).assertDoesNotExist()
        }
        listOf("微信", "QQ", "邮箱", "其他登录方式", "暂不登录").forEach {
            composeRule.onNodeWithText(it).assertDoesNotExist()
        }
    }

    private fun assertProgress(step: AccountRegistrationStep) {
        listOf("验证手机号", "绑定微信", "注册成功").forEachIndexed { index, label ->
            val status = if (index < step.ordinal) "已完成" else if (index == step.ordinal) "当前步骤" else "未完成"
            composeRule.onNodeWithContentDescription("$label，$status").assertIsDisplayed()
        }
    }

    private fun assertBottomPlacement() {
        assertPrivacyBelowPrimary()
        val consent = bounds("auth-consent")
        val root = composeRule.onRoot().fetchSemanticsNode().boundsInRoot
        assertTrue("Privacy must be in the lower section of the normal-height login page", consent.center.y > root.top + root.height * 0.7f)
        val icons = listOf("auth-wechat", "auth-qq", "auth-switch-channel").map(::bounds)
        icons.forEach { assertTrue("Provider actions must be below the privacy row", it.top >= consent.bottom) }
        assertEquals(icons[0].center.y, icons[1].center.y, 1f)
        assertEquals(icons[1].center.y, icons[2].center.y, 1f)
    }

    private fun assertPrivacyBelowPrimary() {
        assertTrue("Privacy must follow the main action", bounds("auth-consent").top > bounds("auth-primary").bottom)
    }

    private fun bounds(tag: String): Rect = composeRule.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot

    private fun assertSameBounds(tag: String, phone: Rect, email: Rect) {
        assertEquals("$tag left alignment", phone.left, email.left, 1f)
        assertEquals("$tag top alignment", phone.top, email.top, 1f)
        assertEquals("$tag width", phone.width, email.width, 1f)
        assertEquals("$tag height", phone.height, email.height, 1f)
    }

    private fun withAuth(
        initial: AccountUiState = guestState(),
        largeText: Boolean = false,
        assertions: (Harness) -> Unit,
    ) {
        val harness = Harness(initial)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                androidx.core.view.WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                    isAppearanceLightStatusBars = !largeText
                    isAppearanceLightNavigationBars = !largeText
                }
                activity.setContent {
                    ChiShenMeTheme(if (largeText) ThemePreference.DARK else ThemePreference.LIGHT) {
                        val density = LocalDensity.current
                        CompositionLocalProvider(LocalDensity provides Density(density.density, if (largeText) 1.6f else 1f)) {
                            AccountAuthLanding(
                                state = harness.state,
                                capabilities = ALL_CAPABILITIES,
                                qqHostAvailable = true,
                                snackbar = remember { SnackbarHostState() },
                                actions = harness.actions,
                            )
                        }
                    }
                }
            }
            assertions(harness)
        }
    }

    private class Harness(initial: AccountUiState) {
        var state by mutableStateOf(initial)
        var requestCodes = 0
        var submissions = 0
        var resends = 0
        var wechatLogins = 0
        var qqLogins = 0
        var wechatBindings = 0
        var finishes = 0
        var privacyOpens = 0
        val notices = mutableListOf<String>()
        val actions = AuthLandingActions(
            onBack = {},
            onPrivacy = { privacyOpens++ },
            onRequestCode = { _, _ -> requestCodes++ },
            onSubmit = { submissions++ },
            onResend = { resends++ },
            onResetChallenge = { state = state.copy(challenge = null) },
            onSelectType = { state = state.copy(otpInputType = it, otpTargetDraft = "", otpCodeDraft = "", challenge = null) },
            onTargetChange = { type, target -> state = state.copy(otpInputType = type, otpTargetDraft = target) },
            onOtpChange = { state = state.copy(otpCodeDraft = it) },
            onLogin = { state = state.copy(entryMode = AccountEntryMode.LOGIN) },
            onRegister = { state = state.copy(entryMode = AccountEntryMode.REGISTER, otpInputType = AuthIdentityType.PHONE) },
            onWechatLogin = { wechatLogins++ },
            onQqLogin = { qqLogins++ },
            onWechatBind = { wechatBindings++ },
            onRefreshIdentities = {},
            onFinish = { finishes++ },
            onNotice = { notices.add(it) },
        )
    }

    companion object {
        private const val SYNTHETIC_PHONE = "13800138000"
        private val alignedTags = listOf(
            "auth-title", "auth-target", "auth-code", "auth-send-code", "auth-primary",
            "auth-consent", "auth-wechat", "auth-qq", "auth-switch-channel",
        )
        private val ALL_CAPABILITIES = AuthCapabilities(
            accountsEnabled = true, registrationEnabled = true, phoneEnabled = true,
            wechatEnabled = true, emailEnabled = true, qqEnabled = true,
        )

        private fun guestState() = AccountUiState(
            status = AccountStatus.GUEST,
            otpInputType = AuthIdentityType.PHONE,
            wechatClientConfigured = true,
            qqClientConfigured = true,
        )

        private fun syntheticChallenge() = PendingOtpChallenge(
            type = AuthIdentityType.PHONE,
            purpose = OtpPurpose.REGISTER,
            challengeId = "33333333-3333-4333-8333-333333333333",
            maskedTarget = "+86138****8000",
            expiresAt = Instant.parse("2030-01-01T00:05:00Z"),
            resendAvailableAt = Instant.parse("2030-01-01T00:00:00Z"),
        )
    }
}
