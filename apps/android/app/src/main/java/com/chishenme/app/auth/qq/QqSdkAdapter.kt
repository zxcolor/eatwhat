package com.chishenme.app.auth.qq

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import com.chishenme.app.BuildConfig
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import com.tencent.tauth.IUiListener
import com.tencent.tauth.Tencent
import com.tencent.tauth.UiError
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import org.json.JSONObject

@Singleton
internal class AppQqConsentGate @Inject constructor(
    private val privacyAuthorizationGate: PrivacyAuthorizationGate,
) : QqConsentGate {
    override suspend fun isAccepted(): Boolean = privacyAuthorizationGate.isAccepted()
}

@Singleton
internal class AndroidQqSdkSessionFactory @Inject constructor(
    @ApplicationContext private val context: Context,
) : QqSdkSessionFactory {
    private val appId = BuildConfig.CHISHENME_QQ_APP_ID.trim()
    private val lock = Any()
    private var sdkPermissionWasGranted = false

    override val isConfigured: Boolean
        get() = appId.matches(QQ_APP_ID)

    override fun create(onCallback: (QqSdkCallback) -> Unit): QqSdkSession = synchronized(lock) {
        check(isConfigured) { "QQ client is not configured" }
        // These are deliberately the first OpenSDK calls. The manager reaches
        // this point only after a user click and a fresh consent check.
        // OpenSDK 3.5.9+ accepts the already-disclosed model explicitly and
        // then does not query it itself. This call remains behind fresh App
        // privacy consent and the user's explicit QQ action.
        Tencent.setIsPermissionGranted(true, Build.MODEL)
        sdkPermissionWasGranted = true
        val applicationContext = context.applicationContext
        val authority = "${applicationContext.packageName}.share-file-provider"
        val tencent = Tencent.createInstance(appId, applicationContext, authority)
            ?: run {
                Tencent.setIsPermissionGranted(false)
                sdkPermissionWasGranted = false
                error("QQ OpenSDK initialization failed")
            }
        AndroidQqSdkSession(applicationContext, tencent, onCallback)
    }

    override fun revokePrivacyConsent() {
        val shouldRevoke = synchronized(lock) {
            sdkPermissionWasGranted.also { sdkPermissionWasGranted = false }
        }
        // Do not load or notify OpenSDK on first-run refusal. This call is made
        // only if a previous explicit, consented action granted the SDK flag.
        if (shouldRevoke) runCatching { Tencent.setIsPermissionGranted(false) }
    }

    private companion object {
        val QQ_APP_ID = Regex("^[1-9][0-9]{4,15}$")
    }
}

private class AndroidQqSdkSession(
    private val context: Context,
    private val tencent: Tencent,
    onCallback: (QqSdkCallback) -> Unit,
) : QqSdkSession {
    private var callback: ((QqSdkCallback) -> Unit)? = onCallback
    private val listener = object : IUiListener {
        override fun onComplete(response: Any?) {
            callback?.invoke(response.toSafeQqCallback())
        }

        override fun onError(error: UiError?) {
            // Never copy errorCode, errorMessage, errorDetail, or toString().
            callback?.invoke(QqSdkCallback.Error)
        }

        override fun onCancel() {
            callback?.invoke(QqSdkCallback.Cancelled)
        }

        override fun onWarning(code: Int) {
            // Warning integers are provider diagnostics and are not surfaced.
            callback?.invoke(QqSdkCallback.Error)
        }
    }

    override fun launchLogin(activity: Activity): Boolean =
        tencent.login(activity, LOGIN_SCOPE, listener) >= 0

    override fun handleActivityResult(
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
    ): Boolean {
        if (requestCode != Tencent.REQUEST_LOGIN) return false
        if (data == null) {
            callback?.invoke(
                if (resultCode == Activity.RESULT_CANCELED) {
                    QqSdkCallback.Cancelled
                } else {
                    QqSdkCallback.Invalid
                },
            )
            return true
        }
        val handled = Tencent.onActivityResultData(requestCode, resultCode, data, listener)
        if (!handled) callback?.invoke(QqSdkCallback.Invalid)
        return true
    }

    override fun clear() {
        callback = null
        runCatching { tencent.logout(context) }
    }

    private companion object {
        const val LOGIN_SCOPE = "get_simple_userinfo"
    }
}

/** Reads only the access token; client-returned open identity is ignored. */
private fun Any?.toSafeQqCallback(): QqSdkCallback {
    val json = this as? JSONObject ?: return QqSdkCallback.Invalid
    if (!json.has("ret") || json.optInt("ret", Int.MIN_VALUE) != 0) {
        return QqSdkCallback.Invalid
    }
    return QqSdkCallback.Authorized(json.optString("access_token").takeIf(String::isNotBlank))
}
