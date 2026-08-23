package com.chishenme.app.feature.account

import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountRuntimeCapabilityUiPolicyTest {
    @Test
    fun `security mutations require a currently enabled account capability`() {
        assertFalse(accountSecurityMutationAvailable(null))
        assertFalse(accountSecurityMutationAvailable(capabilities(enabled = false)))
        assertTrue(accountSecurityMutationAvailable(capabilities(enabled = true)))
    }

    @Test
    fun `deletion remains available during transient refresh but not explicit shutdown`() {
        assertTrue(accountDeletionAvailable(RemoteFeatureConfigState.Loading(2)))
        assertFalse(accountDeletionAvailable(RemoteFeatureConfigState.Unavailable(2)))
        assertFalse(accountDeletionAvailable(RemoteFeatureConfigState.Incompatible(2)))
        assertFalse(accountDeletionAvailable(ready(2, capabilities(enabled = false))))
        assertTrue(accountDeletionAvailable(ready(2, capabilities(enabled = true))))
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

    private fun capabilities(enabled: Boolean) = AuthCapabilities(
        accountsEnabled = enabled,
        registrationEnabled = false,
        phoneEnabled = false,
        wechatEnabled = false,
        emailEnabled = false,
        qqEnabled = false,
        dataExportEnabled = false,
    )
}
