package com.chishenme.app.auth.wechat

import android.content.Context
import android.content.Intent
import com.chishenme.app.BuildConfig
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import com.tencent.mm.opensdk.constants.ConstantsAPI
import com.tencent.mm.opensdk.modelbase.BaseReq
import com.tencent.mm.opensdk.modelbase.BaseResp
import com.tencent.mm.opensdk.modelmsg.SendAuth
import com.tencent.mm.opensdk.openapi.IWXAPI
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler
import com.tencent.mm.opensdk.openapi.WXAPIFactory
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class AppWechatConsentGate @Inject constructor(
    private val privacyAuthorizationGate: PrivacyAuthorizationGate,
) : WechatConsentGate {
    override suspend fun isAccepted(): Boolean = privacyAuthorizationGate.isAccepted()
}

@Singleton
internal class AndroidWechatSdkSessionFactory @Inject constructor(
    @ApplicationContext private val context: Context,
) : WechatSdkSessionFactory {
    private val appId = BuildConfig.CHISHENME_WECHAT_APP_ID.trim()

    override val isConfigured: Boolean
        get() = appId.matches(WECHAT_APP_ID)

    override fun create(): WechatSdkSession {
        check(isConfigured) { "WeChat client is not configured" }
        // This is the first line that initializes OpenSDK, and the manager only
        // reaches it after a consented, explicit user action.
        val api = WXAPIFactory.createWXAPI(
            context.applicationContext,
            appId,
            true,
        )
        return AndroidWechatSdkSession(api, appId)
    }

    private companion object {
        val WECHAT_APP_ID = Regex("^wx[0-9a-fA-F]{16}$")
    }
}

private class AndroidWechatSdkSession(
    private val api: IWXAPI,
    private val appId: String,
) : WechatSdkSession {
    override fun registerApp(): Boolean = api.registerApp(appId)

    override fun isWechatInstalled(): Boolean = api.isWXAppInstalled

    override fun sendAuthorization(state: String): Boolean = api.sendReq(
        SendAuth.Req().apply {
            scope = "snsapi_userinfo"
            this.state = state
        },
    )

    override fun handleIntent(
        intent: Intent,
        onCallback: (WechatSdkCallback) -> Unit,
    ): Boolean = api.handleIntent(
        intent,
        object : IWXAPIEventHandler {
            override fun onReq(request: BaseReq?) {
                onCallback(WechatSdkCallback.Invalid)
            }

            override fun onResp(response: BaseResp?) {
                onCallback(response.toSafeCallback())
            }
        },
    )

    override fun detach() {
        api.detach()
    }
}

/** Never copies errStr, transaction, openId, or numeric error values. */
private fun BaseResp?.toSafeCallback(): WechatSdkCallback {
    val response = this as? SendAuth.Resp ?: return WechatSdkCallback.Invalid
    if (response.type != ConstantsAPI.COMMAND_SENDAUTH) return WechatSdkCallback.Invalid
    return when (response.errCode) {
        BaseResp.ErrCode.ERR_OK -> WechatSdkCallback.Authorized(
            state = response.state,
            authorizationCode = response.code,
        )
        BaseResp.ErrCode.ERR_USER_CANCEL -> WechatSdkCallback.Cancelled
        BaseResp.ErrCode.ERR_AUTH_DENIED -> WechatSdkCallback.Denied
        else -> WechatSdkCallback.Invalid
    }
}
