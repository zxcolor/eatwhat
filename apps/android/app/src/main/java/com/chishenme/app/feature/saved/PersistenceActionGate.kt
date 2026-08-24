package com.chishenme.app.feature.saved

import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.effectivePersistenceCapabilities

internal enum class PersistenceCreation { FAVORITE, PRIVATE_FEEDBACK }

internal sealed interface PersistenceGateDecision {
    data object Allowed : PersistenceGateDecision
    data class Blocked(val message: String) : PersistenceGateDecision
}

internal object PersistenceActionGate {
    fun evaluate(
        config: FeatureConfig?,
        response: RecommendationResponse,
        result: RecommendationResult,
        creation: PersistenceCreation,
    ): PersistenceGateDecision {
        if (result.dataMode == RecommendationDataMode.DEMO) {
            return blocked("演示餐厅不能收藏或记录反馈，本次不会上传")
        }
        if (response.results.none { it.resultToken == result.resultToken }) {
            return blocked("推荐会话已变化，请返回结果页重新打开")
        }
        if (response.dataRightsMode != DataRightsMode.LICENSED_ENRICHMENT) {
            return blocked("当前为实时展示模式，数据授权不允许保存餐厅引用")
        }
        if (config == null) {
            return blocked("保存能力尚未通过远程配置确认，本次不会上传")
        }
        if (!config.accountsEnabled || config.authCapabilities?.accountsEnabled != true) {
            return blocked("账号能力当前未开放；游客核心推荐仍可继续使用")
        }
        if (config.dataRightsMode != DataRightsMode.LICENSED_ENRICHMENT) {
            return blocked("数据授权状态已变化，本次不会上传餐厅引用")
        }
        val capabilities = config.effectivePersistenceCapabilities()
        val enabled = capabilities.savedResourceIdsEnabled && when (creation) {
            PersistenceCreation.FAVORITE -> capabilities.favoritesEnabled
            PersistenceCreation.PRIVATE_FEEDBACK -> capabilities.privateFeedbackEnabled
        }
        return if (enabled) {
            PersistenceGateDecision.Allowed
        } else {
            blocked(
                if (creation == PersistenceCreation.FAVORITE) {
                    "收藏能力当前未开放，本次不会上传"
                } else {
                    "私有反馈能力当前未开放，本次不会上传"
                },
            )
        }
    }

    private fun blocked(message: String) = PersistenceGateDecision.Blocked(message)
}
