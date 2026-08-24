package com.chishenme.app.feature.saved

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.PersistenceCapabilities
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PersistenceActionGateTest {
    @Test
    fun `demo and live display results fail closed without leaking proof`() {
        val demo = result(RecommendationDataMode.DEMO)
        val demoDecision = PersistenceActionGate.evaluate(
            config(),
            response(DataRightsMode.LICENSED_ENRICHMENT, demo),
            demo,
            PersistenceCreation.FAVORITE,
        )
        assertBlockedWithoutToken(demoDecision, demo.resultToken)

        val live = result()
        val liveDisplayDecision = PersistenceActionGate.evaluate(
            config(),
            response(DataRightsMode.LIVE_DISPLAY_ONLY, live),
            live,
            PersistenceCreation.PRIVATE_FEEDBACK,
        )
        assertBlockedWithoutToken(liveDisplayDecision, live.resultToken)
    }

    @Test
    fun `missing persistence capabilities are treated as all disabled`() {
        val result = result()
        val decision = PersistenceActionGate.evaluate(
            config().copy(persistenceCapabilities = null),
            response(DataRightsMode.LICENSED_ENRICHMENT, result),
            result,
            PersistenceCreation.FAVORITE,
        )
        assertTrue(decision is PersistenceGateDecision.Blocked)
    }

    @Test
    fun `licensed current result with explicit capabilities is allowed`() {
        val result = result()
        val response = response(DataRightsMode.LICENSED_ENRICHMENT, result)

        assertTrue(
            PersistenceActionGate.evaluate(
                config(),
                response,
                result,
                PersistenceCreation.FAVORITE,
            ) is PersistenceGateDecision.Allowed,
        )
        assertTrue(
            PersistenceActionGate.evaluate(
                config(),
                response,
                result,
                PersistenceCreation.PRIVATE_FEEDBACK,
            ) is PersistenceGateDecision.Allowed,
        )
    }

    @Test
    fun `creation also requires saved resource ids capability`() {
        val result = result()
        val config = config().copy(
            persistenceCapabilities = config().persistenceCapabilities?.copy(savedResourceIdsEnabled = false),
        )

        assertTrue(
            PersistenceActionGate.evaluate(
                config,
                response(DataRightsMode.LICENSED_ENRICHMENT, result),
                result,
                PersistenceCreation.FAVORITE,
            ) is PersistenceGateDecision.Blocked,
        )
    }

    @Test
    fun `result from another response is rejected without exposing token`() {
        val current = result(token = "A".repeat(43))
        val stale = result(token = "B".repeat(43))
        val decision = PersistenceActionGate.evaluate(
            config(),
            response(DataRightsMode.LICENSED_ENRICHMENT, current),
            stale,
            PersistenceCreation.FAVORITE,
        )
        assertBlockedWithoutToken(decision, stale.resultToken)
    }

    private fun assertBlockedWithoutToken(decision: PersistenceGateDecision, token: String) {
        assertTrue(decision is PersistenceGateDecision.Blocked)
        assertFalse((decision as PersistenceGateDecision.Blocked).message.contains(token))
        assertFalse(decision.message.contains("resultToken"))
    }

    private fun config() = FeatureConfig(
        coverageName = "全国服务",
        dataRightsMode = DataRightsMode.LICENSED_ENRICHMENT,
        aiEnabled = false,
        accountsEnabled = true,
        favoritesEnabled = true,
        minimumSupportedVersion = "0.1.0",
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback-v1",
        persistenceCapabilities = PersistenceCapabilities(
            favoritesEnabled = true,
            historyEnabled = true,
            privateFeedbackEnabled = true,
            savedResourceIdsEnabled = true,
        ),
        authCapabilities = AuthCapabilities(
            accountsEnabled = true,
            registrationEnabled = true,
            phoneEnabled = true,
            wechatEnabled = true,
            emailEnabled = true,
            qqEnabled = false,
        ),
    )

    private fun response(mode: DataRightsMode, result: RecommendationResult) = RecommendationResponse(
        requestId = "11111111-1111-4111-8111-111111111111",
        generatedAt = "2026-08-21T00:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = mode,
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback-v1",
        aiFallbackUsed = false,
        results = listOf(result),
        notice = null,
    )

    private fun result(
        mode: RecommendationDataMode = RecommendationDataMode.LIVE,
        token: String = "A".repeat(43),
    ) = RecommendationResult(
        provider = "AUTHORIZED_SOURCE",
        resultToken = token,
        dataMode = mode,
        actions = RecommendationActions(false, false, false, false),
        name = "学院路面馆",
        address = "海淀区学院路 25 号",
        rank = 1,
        fitScore = 80.0,
        sourceRating = null,
        averageCostYuan = 25.0,
        distanceMeters = 300.0,
        estimatedTravelMinutes = 5.0,
        estimatedMealMinutes = 20.0,
        openStatus = OpenStatus.OPEN,
        tags = listOf("面食"),
        imageUrl = null,
        phone = null,
        location = Coordinate(39.9, 116.4, null, CoordinateReferenceSystem.GCJ02),
        reasons = emptyList(),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "经授权餐厅数据",
    )
}
