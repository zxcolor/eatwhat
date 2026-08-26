package com.chishenme.app.auth.fusion

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.http.SslError
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.mobile.auth.gatewayauth.Constant
import java.io.ByteArrayInputStream

/**
 * Non-exported host page required by the pinned SDK for carrier agreement links.
 * It intentionally implements a much narrower WebView policy than the vendor demo.
 */
class FusionProtocolActivity : Activity() {
    private var protocolWebView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val protocolUrl = intent.getStringExtra(Constant.PROTOCOL_WEB_VIEW_URL)
        if (!FusionProtocolUrlPolicy.isAllowed(protocolUrl)) {
            finish()
            return
        }

        requestedOrientation = safeOrientation(
            intent.getIntExtra(
                Constant.PROTOCOL_WEB_VIEW_ORIENTATION,
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
            ),
        )
        val title = intent.getStringExtra(Constant.PROTOCOL_WEB_VIEW_NAME)
            ?.take(80)
            ?.takeIf(String::isNotBlank)
            ?: "认证服务协议"

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        toolbar.addView(
            Button(this).apply {
                text = "返回"
                contentDescription = "返回认证页面"
                setOnClickListener { finish() }
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        toolbar.addView(
            TextView(this).apply {
                text = title
                textSize = 18f
                setTextColor(Color.BLACK)
                setPadding(16, 16, 16, 16)
            },
            LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f,
            ),
        )
        root.addView(
            toolbar,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        val webView = WebView(this)
        protocolWebView = webView
        configure(webView)
        root.addView(
            webView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ),
        )
        setContentView(root)
        webView.loadUrl(requireNotNull(protocolUrl))
    }

    private fun configure(webView: WebView) {
        WebView.setWebContentsDebuggingEnabled(false)
        webView.settings.apply {
            javaScriptEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            domStorageEnabled = false
            databaseEnabled = false
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            safeBrowsingEnabled = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean = !FusionProtocolUrlPolicy.isAllowed(request?.url?.toString())

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean =
                !FusionProtocolUrlPolicy.isAllowed(url)

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ): WebResourceResponse? = if (
                FusionProtocolUrlPolicy.isAllowed(request?.url?.toString())
            ) {
                null
            } else {
                WebResourceResponse(
                    "text/plain",
                    Charsets.UTF_8.name(),
                    ByteArrayInputStream(ByteArray(0)),
                )
            }

            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?,
            ) {
                handler?.cancel()
            }
        }
    }

    override fun onDestroy() {
        protocolWebView?.let { webView ->
            webView.stopLoading()
            webView.webViewClient = WebViewClient()
            webView.clearHistory()
            webView.removeAllViews()
            webView.destroy()
        }
        protocolWebView = null
        super.onDestroy()
    }

    private fun safeOrientation(requested: Int): Int = requested.takeIf {
        it in setOf(
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
            ActivityInfo.SCREEN_ORIENTATION_SENSOR,
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT,
        )
    } ?: ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
}
