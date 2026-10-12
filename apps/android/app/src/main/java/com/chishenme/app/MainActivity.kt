package com.chishenme.app

import android.content.Intent
import android.os.Bundle
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.chishenme.app.auth.qq.QqOAuthManager
import com.chishenme.app.auth.wechat.WechatOAuthManager
import com.chishenme.app.data.local.ThemePreference
import com.chishenme.app.data.local.NearbyCacheCleanupService
import com.chishenme.app.feature.consent.ConsentScreen
import com.chishenme.app.feature.consent.ConsentViewModel
import com.chishenme.app.ui.AppNavigation
import com.chishenme.app.ui.AppLaunchLoading
import com.chishenme.app.ui.theme.ChiShenMeTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private val launchTimestampMillis = System.currentTimeMillis()
    @Inject lateinit var qqOAuth: QqOAuthManager
    @Inject lateinit var wechatOAuth: WechatOAuthManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        NearbyCacheCleanupService.schedule(this)
        setContent {
            ChiShenMeApp(
                window = window,
                qqOAuth = qqOAuth,
                wechatOAuth = wechatOAuth,
                launchTimestampMillis = launchTimestampMillis,
            )
        }
    }

    @Deprecated("Android callback required by QQ OpenSDK 3.5.19")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        qqOAuth.handleActivityResult(requestCode, resultCode, data)
    }
}

@Composable
private fun ChiShenMeApp(
    window: Window,
    qqOAuth: QqOAuthManager,
    wechatOAuth: WechatOAuthManager,
    launchTimestampMillis: Long,
    consentViewModel: ConsentViewModel = hiltViewModel(),
) {
    val accepted by consentViewModel.privacyAccepted.collectAsStateWithLifecycle()
    val theme by consentViewModel.themePreference.collectAsStateWithLifecycle()
    val withdrawalPersistenceFailed by
        consentViewModel.withdrawalPersistenceFailed.collectAsStateWithLifecycle()
    val acceptanceState by consentViewModel.acceptanceState.collectAsStateWithLifecycle()
    val systemDarkTheme = isSystemInDarkTheme()
    val darkTheme = when (theme) {
        ThemePreference.SYSTEM -> systemDarkTheme
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
    }
    val contentView = LocalView.current

    SideEffect {
        WindowCompat.getInsetsController(window, contentView).apply {
            isAppearanceLightStatusBars = !darkTheme
            isAppearanceLightNavigationBars = !darkTheme
        }
    }

    LaunchedEffect(accepted) {
        if (accepted == true) {
            runCatching { wechatOAuth.allowPrivacyConsent() }
            runCatching { qqOAuth.allowPrivacyConsent() }
        } else {
            runCatching { wechatOAuth.revokePrivacyConsent() }
            runCatching { qqOAuth.revokePrivacyConsent() }
        }
    }

    ChiShenMeTheme(themePreference = theme) {
        when (accepted) {
            null -> AppLaunchLoading()
            false -> ConsentScreen(
                onAccept = consentViewModel::acceptPrivacy,
                withdrawalPersistenceFailed = withdrawalPersistenceFailed,
                acceptanceState = acceptanceState,
            )
            true -> AppNavigation(
                launchTimestampMillis = launchTimestampMillis,
                onWithdrawPrivacy = {
                    consentViewModel.withdrawPrivacy {
                        runCatching { wechatOAuth.revokePrivacyConsent() }
                        runCatching { qqOAuth.revokePrivacyConsent() }
                    }
                },
            )
        }
    }
}
