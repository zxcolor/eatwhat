package com.chishenme.app.auth.wechat

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Shared implementation behind each variant's canonical WXEntryActivity. */
abstract class WechatCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        dispatch(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        dispatch(intent)
    }

    private fun dispatch(callbackIntent: Intent?) {
        val manager = WechatOAuthRuntimeRegistry.active()
        if (callbackIntent != null && manager != null) {
            manager.handleCallbackIntent(callbackIntent)
        }
        // No pending in-process state (including a process restart) is a hard
        // failure. Do not initialize OpenSDK or attempt to recover from extras.
        finish()
    }
}
