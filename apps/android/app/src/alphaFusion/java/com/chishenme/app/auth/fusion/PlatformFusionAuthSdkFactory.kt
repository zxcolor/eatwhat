package com.chishenme.app.auth.fusion

import android.app.Activity
import android.graphics.Color
import com.alicom.fusion.auth.AlicomFusionAuthUICallBack
import com.alicom.fusion.auth.AlicomFusionAuthCallBack
import com.alicom.fusion.auth.AlicomFusionBusiness
import com.alicom.fusion.auth.AlicomFusionLog
import com.alicom.fusion.auth.HalfWayVerifyResult
import com.alicom.fusion.auth.error.AlicomFusionEvent
import com.alicom.fusion.auth.numberauth.FusionNumberAuthModel
import com.alicom.fusion.auth.smsauth.AlicomFusionVerifyCodeView
import com.alicom.fusion.auth.token.AlicomFusionAuthToken
import com.alicom.fusion.auth.upsms.AlicomFusionUpSMSView
import javax.inject.Inject

/** Exact adapter for the locally prepared, integrity-pinned official SDK. */
internal class PlatformFusionAuthSdkFactory @Inject constructor() : FusionAuthSdkFactory {
    override val available: Boolean = true

    override fun create(): FusionAuthSdk = AlicomFusionAuthSdk()
}

private class AlicomFusionAuthSdk : FusionAuthSdk {
    private val callbackGate = FusionAuthCallbackGate<AlicomFusionBusiness> { current ->
        runCatching { current.stopSceneWithTemplateId(TEMPLATE_ID) }
        runCatching { current.destory() }
    }

    override fun start(
        activity: Activity,
        schemeCode: String,
        authToken: String,
        listener: FusionAuthSdkListener,
    ): Boolean {
        if (callbackGate.isClosed) return false

        // The selected global strategy includes the official device-risk node.
        // Its two integrity-pinned Umeng AARs are packaged only in an explicitly
        // requested Fusion Alpha build and initialized behind the same consent gate.
        AlicomFusionBusiness.useSDKSupplyUMSDK(true, "umeng")
        AlicomFusionLog.setLogEnable(false)

        val instance = AlicomFusionBusiness()
        val initialToken = AlicomFusionAuthToken().apply { setAuthToken(authToken) }
        if (!callbackGate.attach(instance)) return false

        val initialized = try {
            callbackGate.runIfOpen { current ->
                current.initWithToken(activity.applicationContext, schemeCode, initialToken)
                current.setAlicomFusionAuthCallBack(
                    object : AlicomFusionAuthCallBack {
                        override fun onSDKTokenUpdate(): AlicomFusionAuthToken {
                            // This synchronous callback cannot fetch a new server token.
                            // Returning a new empty token fails closed without re-entering
                            // cancellation while the SDK is waiting for the return value.
                            return AlicomFusionAuthToken().apply {
                                setAuthToken(callbackGate.failClosedRefreshToken())
                            }
                        }

                        override fun onSDKTokenAuthSuccess() {
                            try {
                                callbackGate.startSceneOnce { active ->
                                    active.startSceneWithTemplateId(
                                        activity,
                                        TEMPLATE_ID,
                                        fusionUiCallback(),
                                    )
                                }
                            } catch (_: Exception) {
                                callbackGate.notifyTerminal(listener::onFailure)
                            }
                        }

                        override fun onSDKTokenAuthFailure(
                            token: AlicomFusionAuthToken?,
                            event: AlicomFusionEvent?,
                        ) {
                            callbackGate.notifyTerminal(listener::onFailure)
                        }

                        override fun onVerifySuccess(
                            verifyToken: String?,
                            nodeName: String?,
                            event: AlicomFusionEvent?,
                        ) {
                            val proof = verifyToken
                            if (proof == null) {
                                callbackGate.notifyTerminal(listener::onFailure)
                                return
                            }
                            val completion = callbackGate.oneShotOperation { active, success ->
                                active.continueSceneWithTemplateId(TEMPLATE_ID, success)
                            }
                            listener.onProof(proof) { success -> completion(success) }
                        }

                        override fun onHalfWayVerifySuccess(
                            nodeName: String?,
                            maskedToken: String?,
                            event: AlicomFusionEvent?,
                            result: HalfWayVerifyResult?,
                        ) {
                            val proof = maskedToken
                            if (proof == null || result == null) {
                                if (result != null) {
                                    runCatching {
                                        callbackGate.runIfOpen { result.verifyResult(false) }
                                    }
                                }
                                callbackGate.notifyTerminal(listener::onFailure)
                                return
                            }
                            val completion = callbackGate.oneShotOperation { _, success ->
                                result.verifyResult(success)
                            }
                            listener.onProof(proof) { success -> completion(success) }
                        }

                        override fun onVerifyFailed(
                            event: AlicomFusionEvent?,
                            nodeName: String?,
                        ) {
                            // A failed node is input to the configured global strategy:
                            // false allows its captcha/SMS/fallback edge to run.
                            try {
                                callbackGate.runIfOpen { active ->
                                    active.continueSceneWithTemplateId(TEMPLATE_ID, false)
                                }
                            } catch (_: Exception) {
                                callbackGate.notifyTerminal(listener::onFailure)
                            }
                        }

                        override fun onTemplateFinish(event: AlicomFusionEvent?) {
                            callbackGate.notifyTerminal(listener::onFinished)
                        }

                        override fun onAuthEvent(event: AlicomFusionEvent?) = Unit

                        // The app never supplies a guessed, cached, or user-entered phone
                        // number. The server remains authoritative after proof verification.
                        override fun onGetPhoneNumberForVerification(
                            nodeName: String?,
                            event: AlicomFusionEvent?,
                        ): String = ""

                        override fun onVerifyInterrupt(event: AlicomFusionEvent?) {
                            // Missing protocol acceptance, editable input and temporary
                            // loading interruptions remain recoverable inside the SDK UI.
                        }
                    },
                )
            }
        } catch (_: Exception) {
            callbackGate.close()
            false
        }

        // A synchronous provider callback may have terminally closed the gate while
        // setAlicomFusionAuthCallBack was still on the stack.
        return initialized && !callbackGate.isClosed
    }

    override fun cancel() {
        callbackGate.close()
    }

    /**
     * Uses only the SDK's documented customization surface. It keeps every
     * provider input and protocol control intact while aligning the first-party
     * title, action and colors with the app. Physical-device review still owns
     * density, carrier and fallback-node acceptance; no demo views or assets are
     * copied into the production package.
     */
    private fun fusionUiCallback(): AlicomFusionAuthUICallBack =
        object : AlicomFusionAuthUICallBack {
            override fun onPhoneNumberVerifyUICustomView(
                templateId: String,
                nodeId: String,
                model: FusionNumberAuthModel,
            ) {
                model.builder
                    .setNavText("手机号验证")
                    .setNavColor(PAGE_BACKGROUND)
                    .setNavTextColor(TEXT_PRIMARY)
                    .setStatusBarColor(PAGE_BACKGROUND)
                    .setBottomNavColor(PAGE_BACKGROUND)
                    .setLightColor(true)
                    .setNumberColor(TEXT_PRIMARY)
                    .setSloganText("由运营商安全验证本机号码")
                    .setSloganTextColor(TEXT_SECONDARY)
                    .setLogBtnText("手机号一键验证")
                    .setLogBtnTextColor(Color.WHITE)
                    .setSwitchAccText("使用其他验证方式")
                    .setSwitchAccTextColor(ACTION_ORANGE)
                    .setPrivacyBefore("请阅读并同意")
                    .setPrivacyEnd("")
                    .setPrivacyAlertIsNeedShow(true)
                    .setPrivacyAlertIsNeedAutoLogin(false)
                    .setPrivacyAlertTitleContent("请确认授权")
                    .setPrivacyAlertBtnContent("同意并继续")
                    .setPrivacyAlertBtnTextColor(Color.WHITE)
                    .setPrivacyAlertTitleColor(TEXT_PRIMARY)
                    .setPrivacyAlertContentColor(TEXT_SECONDARY)
                    .setPrivacyOneColor(ACTION_ORANGE)
                    .setPrivacyTwoColor(ACTION_ORANGE)
                    .setPrivacyThreeColor(ACTION_ORANGE)
                    .setPrivacyOperatorColor(ACTION_ORANGE)
                    .setPrivacyAlertOneColor(ACTION_ORANGE)
                    .setPrivacyAlertTwoColor(ACTION_ORANGE)
                    .setPrivacyAlertThreeColor(ACTION_ORANGE)
                    .setPrivacyAlertOperatorColor(ACTION_ORANGE)
                    .setWebSupportedJavascript(false)
                    .setProtocolAction(PROTOCOL_ACTION)
                    .setPrivacyState(false)
            }

            override fun onSMSCodeVerifyUICustomView(
                templateId: String,
                nodeId: String,
                autoInput: Boolean,
                view: AlicomFusionVerifyCodeView,
            ) {
                view.rootRl?.setBackgroundColor(PAGE_BACKGROUND)
                view.titleContentTV?.apply {
                    text = "短信验证"
                    setTextColor(TEXT_PRIMARY)
                }
            }

            override fun onSMSSendVerifyUICustomView(
                templateId: String,
                nodeId: String,
                view: AlicomFusionUpSMSView,
                destinationNumber: String,
                smsContent: String,
            ) {
                view.rootRl?.setBackgroundColor(PAGE_BACKGROUND)
                view.titleContentTV?.apply {
                    text = "短信验证"
                    setTextColor(TEXT_PRIMARY)
                }
                view.sendSmsTV?.setTextColor(ACTION_ORANGE)
            }
        }

    private companion object {
        const val TEMPLATE_ID = "100001"
        const val PROTOCOL_ACTION = "com.fusion.auth"
        val PAGE_BACKGROUND: Int = Color.rgb(255, 249, 244)
        val TEXT_PRIMARY: Int = Color.rgb(45, 34, 28)
        val TEXT_SECONDARY: Int = Color.rgb(98, 86, 78)
        val ACTION_ORANGE: Int = Color.rgb(255, 107, 43)
    }
}
