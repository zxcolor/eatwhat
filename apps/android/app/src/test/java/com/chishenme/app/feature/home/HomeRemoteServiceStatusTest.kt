package com.chishenme.app.feature.home

import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.ServiceCapabilities
import com.chishenme.app.feature.config.RemoteFeatureConfigState
import com.chishenme.app.feature.decision.DecisionUiState
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeRemoteServiceStatusTest {
    @Test
    fun `fully available cloud services need no warning card`() {
        val message = remoteServiceStatusMessage(
            DecisionUiState(
                remoteFeatureConfig = RemoteFeatureConfigState.Ready(
                    generation = 1,
                    config = config(
                        ServiceCapabilities(
                            recommendationsEnabled = true,
                            locationSearchEnabled = true,
                            placeSearchEnabled = true,
                        ),
                    ),
                ),
            ),
        )

        assertNull(message)
    }

    @Test
    fun `missing capability object visibly fails every remote service closed`() {
        val message = requireNotNull(
            remoteServiceStatusMessage(
                DecisionUiState(
                    remoteFeatureConfig = RemoteFeatureConfigState.Ready(1, config(null)),
                ),
            ),
        )

        assertTrue(message.contains("餐厅推荐"))
        assertTrue(message.contains("地点搜索"))
        assertTrue(message.contains("餐厅搜索"))
    }

    @Test
    fun `unavailable config explains the remaining guest boundary`() {
        val message = requireNotNull(
            remoteServiceStatusMessage(
                DecisionUiState(remoteFeatureConfig = RemoteFeatureConfigState.Unavailable(1)),
            ),
        )

        assertTrue(message.contains("规则推荐"))
        assertTrue(message.contains("账号能力已关闭"))
    }

    private fun config(capabilities: ServiceCapabilities?) = FeatureConfig(
        coverageName = "北京四环试点区",
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        aiEnabled = false,
        accountsEnabled = false,
        favoritesEnabled = false,
        minimumSupportedVersion = "0.1.0",
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback-v1",
        serviceCapabilities = capabilities,
    )
}
