package com.chishenme.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.chishenme.app.auth.qq.QqOAuthManager
import com.chishenme.app.auth.wechat.WechatOAuthManager
import com.chishenme.app.feature.consent.ConsentScreen
import com.chishenme.app.feature.consent.ConsentViewModel
import com.chishenme.app.ui.AppNavigation
import com.chishenme.app.ui.theme.ChiShenMeTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var qqOAuth: QqOAuthManager
    @Inject lateinit var wechatOAuth: WechatOAuthManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { ChiShenMeApp(qqOAuth = qqOAuth, wechatOAuth = wechatOAuth) }
    }

    @Deprecated("Android callback required by QQ OpenSDK 3.5.19")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        qqOAuth.handleActivityResult(requestCode, resultCode, data)
    }
}

@Composable
private fun ChiShenMeApp(
    qqOAuth: QqOAuthManager,
    wechatOAuth: WechatOAuthManager,
    consentViewModel: ConsentViewModel = hiltViewModel(),
) {
    val accepted by consentViewModel.privacyAccepted.collectAsStateWithLifecycle()
    val theme by consentViewModel.themePreference.collectAsStateWithLifecycle()
    val withdrawalPersistenceFailed by
        consentViewModel.withdrawalPersistenceFailed.collectAsStateWithLifecycle()

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
            null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            false -> ConsentScreen(
                onAccept = consentViewModel::acceptPrivacy,
                withdrawalPersistenceFailed = withdrawalPersistenceFailed,
            )
            true -> AppNavigation(
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
