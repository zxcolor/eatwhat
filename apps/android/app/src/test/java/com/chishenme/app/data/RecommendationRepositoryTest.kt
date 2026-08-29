package com.chishenme.app.data

import com.chishenme.app.data.remote.AuthCapabilities
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.FeatureConfig
import com.chishenme.app.data.remote.IncompatibleApiContractException
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationApi
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationEvent
import com.chishenme.app.data.remote.RecommendationEventType
import com.chishenme.app.data.remote.RecommendationReason
import com.chishenme.app.data.remote.RecommendationResponse
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.data.remote.ReasonCode
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import retrofit2.Response

class RecommendationRepositoryTest {
    @Test
    fun `recommend maps API contract mismatch to an explicit update message`() = runTest {
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = error("unused")

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse {
                    throw IncompatibleApiContractException()
                }

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
            },
        )

        val outcome = repository.recommend(validContext())

        assertTrue(outcome is RecommendationOutcome.Failure)
        outcome as RecommendationOutcome.Failure
        assertEquals(FailureKind.INCOMPATIBLE_API, outcome.kind)
        assertEquals("当前 App 与推荐服务版本不兼容，请更新 App 后重试", outcome.message)
    }

    @Test
    fun `feature config safely degrades when API contract is incompatible`() = runTest {
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig {
                    throw IncompatibleApiContractException()
                }

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
            },
        )

        assertEquals(FeatureConfigOutcome.Incompatible, repository.featureConfig())
    }

    @Test
    fun `feature config distinguishes unavailable transport from incompatibility`() = runTest {
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig {
                    throw IOException("transport unavailable")
                }

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
            },
        )

        assertEquals(FeatureConfigOutcome.Unavailable, repository.featureConfig())
    }

    @Test
    fun `feature config returns validated success`() = runTest {
        val config = validFeatureConfig()
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = config

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
            },
        )

        assertEquals(FeatureConfigOutcome.Success(config), repository.featureConfig())
    }

    @Test
    fun `feature config propagates guest feedback independently from account availability`() = runTest {
        val config = validFeatureConfig().copy(
            accountsEnabled = false,
            supportFeedbackEnabled = true,
        )
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = config

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse =
                    error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> =
                    error("unused")
            },
        )

        val outcome = repository.featureConfig()

        assertEquals(FeatureConfigOutcome.Success(config), outcome)
        assertTrue((outcome as FeatureConfigOutcome.Success).config.supportFeedbackEnabled)
    }

    @Test
    fun `feature config strictly propagates an enabled account export capability`() = runTest {
        val config = validFeatureConfig().copy(
            accountsEnabled = true,
            authCapabilities = authCapabilities(dataExportEnabled = true),
        )
        val repository = RecommendationRepository(
            object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = config

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse =
                    error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> =
                    error("unused")
            },
        )

        val outcome = repository.featureConfig()

        assertEquals(FeatureConfigOutcome.Success(config), outcome)
        assertTrue(
            ((outcome as FeatureConfigOutcome.Success).config.authCapabilities?.dataExportEnabled == true),
        )
    }

    @Test
    fun `feature config rejects data export when accounts are disabled`() = runTest {
        val config = validFeatureConfig().copy(
            accountsEnabled = false,
            authCapabilities = authCapabilities(
                accountsEnabled = false,
                dataExportEnabled = true,
            ),
        )
        val repository = RecommendationRepository(
            object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = config

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse =
                    error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> =
                    error("unused")
            },
        )

        assertEquals(FeatureConfigOutcome.Unavailable, repository.featureConfig())
    }

    @Test
    fun `feature config rejects registration without ordinary phone OTP`() = runTest {
        val capabilities = AuthCapabilities(
            accountsEnabled = true,
            registrationEnabled = true,
            phoneEnabled = false,
            wechatEnabled = true,
            emailEnabled = false,
            qqEnabled = false,
            dataExportEnabled = false,
        )
        val config = validFeatureConfig().copy(
            accountsEnabled = true,
            authCapabilities = capabilities,
        )
        val repository = RecommendationRepository(
            object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = config

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse =
                    error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> =
                    error("unused")
            },
        )

        assertEquals(FeatureConfigOutcome.Unavailable, repository.featureConfig())
    }

    @Test
    fun `feature config accepts all auth capabilities disabled with accounts`() = runTest {
        val config = validFeatureConfig().copy(
            accountsEnabled = false,
            authCapabilities = AuthCapabilities(
                accountsEnabled = false,
                registrationEnabled = false,
                phoneEnabled = false,
                wechatEnabled = false,
                emailEnabled = false,
                qqEnabled = false,
            ),
        )
        val repository = RecommendationRepository(
            object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = config

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse =
                    error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> =
                    error("unused")
            },
        )

        assertEquals(FeatureConfigOutcome.Success(config), repository.featureConfig())
    }

    @Test
    fun `recommend recognizes a wrapped API contract mismatch`() = runTest {
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = error("unused")

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse {
                    throw IOException("network wrapper", IncompatibleApiContractException())
                }

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
            },
        )

        val outcome = repository.recommend(validContext()) as RecommendationOutcome.Failure

        assertEquals(FailureKind.INCOMPATIBLE_API, outcome.kind)
        assertEquals("当前 App 与推荐服务版本不兼容，请更新 App 后重试", outcome.message)
    }

    @Test
    fun `recommend validates results against the original request context`() = runTest {
        val context = RecommendationContext(
            location = Coordinate(39.9928, 116.3109, crs = CoordinateReferenceSystem.WGS84),
            mealPeriod = MealPeriod.LUNCH,
            budgetMaxYuan = 50,
            radiusMeters = 1_500,
        )
        val validResponse = validResponse()
        val response = validResponse.copy(
            results = listOf(validResponse.results.single().copy(distanceMeters = 1_501.0)),
        )
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = error("unused")

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse = response

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> = error("unused")
            },
        )

        val outcome = repository.recommend(context)

        assertTrue(outcome is RecommendationOutcome.Failure)
        assertEquals(FailureKind.INVALID_RESPONSE, (outcome as RecommendationOutcome.Failure).kind)
    }

    @Test
    fun `event reporting preserves coroutine cancellation`() = runTest {
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = error("unused")

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> {
                    throw CancellationException("privacy consent withdrawn")
                }
            },
        )

        try {
            repository.recordEvent(
                requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
                resultToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                type = RecommendationEventType.IMPRESSION,
            )
            fail("CancellationException must propagate")
        } catch (_: CancellationException) {
            // Expected: privacy withdrawal must cancel in-flight event uploads.
        }
    }

    @Test
    fun `event reporting forwards only the opaque result token`() = runTest {
        var captured: RecommendationEvent? = null
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = error("unused")

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> {
                    captured = event
                    return Response.success(Unit)
                }
            },
        )

        repository.recordEvent(
            requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
            resultToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            type = RecommendationEventType.DETAIL,
        )

        assertEquals("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", captured?.resultToken)
    }

    @Test
    fun `event reporting drops a malformed result token before network access`() = runTest {
        var called = false
        val repository = RecommendationRepository(
            api = object : RecommendationApi {
                override suspend fun featureConfig(): FeatureConfig = error("unused")

                override suspend fun recommend(context: RecommendationContext): RecommendationResponse = error("unused")

                override suspend fun recordEvent(event: RecommendationEvent): Response<Unit> {
                    called = true
                    return Response.success(Unit)
                }
            },
        )

        repository.recordEvent(
            requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
            resultToken = "not-a-valid-token",
            type = RecommendationEventType.DETAIL,
        )

        assertTrue(!called)
    }

    private fun validResponse() = RecommendationResponse(
        requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
        generatedAt = "2026-08-20T04:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback",
        aiFallbackUsed = true,
        results = listOf(
            RecommendationResult(
                provider = "DEMO",
                resultToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                dataMode = RecommendationDataMode.DEMO,
                actions = RecommendationActions(
                    navigate = true,
                    call = true,
                    copyAddress = true,
                    share = true,
                ),
                name = "演示面馆",
                address = "北京市海淀区测试路 1 号",
                rank = 1,
                fitScore = null,
                sourceRating = 4.5,
                averageCostYuan = 35.0,
                distanceMeters = 520.0,
                estimatedTravelMinutes = 8.0,
                estimatedMealMinutes = 22.0,
                openStatus = OpenStatus.OPEN,
                tags = listOf("面食"),
                imageUrl = null,
                phone = null,
                location = Coordinate(39.99, 116.31, crs = CoordinateReferenceSystem.WGS84),
                reasons = listOf(RecommendationReason(ReasonCode.DISTANCE_FIT, "距离符合要求")),
                warnings = emptyList(),
                confidence = Confidence.HIGH,
                aiAssisted = false,
                sourceAttribution = "演示数据",
            ),
        ),
        notice = null,
    )

    private fun validContext() = RecommendationContext(
        location = Coordinate(39.9928, 116.3109, crs = CoordinateReferenceSystem.WGS84),
        mealPeriod = MealPeriod.LUNCH,
        budgetMaxYuan = 50,
        radiusMeters = 1_500,
    )

    private fun validFeatureConfig() = FeatureConfig(
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        aiEnabled = true,
        accountsEnabled = false,
        favoritesEnabled = false,
        coverageName = "全国服务",
        minimumSupportedVersion = "0.1.0",
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback",
    )

    private fun authCapabilities(
        accountsEnabled: Boolean = true,
        dataExportEnabled: Boolean,
    ) = AuthCapabilities(
        accountsEnabled = accountsEnabled,
        registrationEnabled = false,
        phoneEnabled = accountsEnabled,
        wechatEnabled = accountsEnabled,
        emailEnabled = accountsEnabled,
        qqEnabled = false,
        dataExportEnabled = dataExportEnabled,
    )
}
