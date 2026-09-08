package com.chishenme.app.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecommendationResponseValidatorTest {
    private val context = RecommendationContext(
        location = Coordinate(
            latitude = 39.9928,
            longitude = 116.3109,
            crs = CoordinateReferenceSystem.WGS84,
        ),
        mealPeriod = MealPeriod.LUNCH,
        budgetMaxYuan = 50,
        availableMinutes = 30,
        radiusMeters = 1_500,
        excludedCuisines = listOf("火锅"),
    )

    @Test
    fun `rejects an explicitly closed result but accepts unknown open status`() {
        assertFalse(isValid(result().copy(openStatus = OpenStatus.CLOSED)))
        assertTrue(isValid(result().copy(openStatus = OpenStatus.UNKNOWN)))
    }

    @Test
    fun `rejects distance beyond requested radius and accepts the boundary`() {
        assertFalse(isValid(result().copy(distanceMeters = 1_500.01)))
        assertTrue(isValid(result().copy(distanceMeters = 1_500.0)))
    }

    @Test
    fun `rejects known cost beyond budget without rejecting an unknown cost`() {
        assertFalse(isValid(result().copy(averageCostYuan = 50.01)))
        assertTrue(isValid(result().copy(averageCostYuan = 50.0)))
        assertTrue(isValid(result().copy(averageCostYuan = null)))
    }

    @Test
    fun `rejects an explicitly excluded cuisine but not missing tag information`() {
        assertFalse(isValid(result().copy(tags = listOf("重庆火锅", "聚餐"))))
        assertTrue(isValid(result().copy(tags = emptyList())))
        assertFalse(isValid(result().copy(tags = listOf(" "))))
    }

    @Test
    fun `rejects grouped cuisine and provider child tags in either data rights mode`() {
        val groupedContext = context.copy(excludedCuisines = listOf("川湘菜"))
        for (mode in DataRightsMode.entries) {
            for (tags in listOf(
                listOf("川湘菜"),
                listOf("川菜"),
                listOf("湘菜"),
                listOf("正餐", "四川菜(川菜)"),
                listOf("正餐", " 湖南湘菜 "),
            )) {
                assertFalse(
                    "$mode: $tags",
                    RecommendationResponseValidator.isValid(
                        response(result().copy(tags = tags)).copy(dataRightsMode = mode),
                        groupedContext,
                    ),
                )
            }
        }
    }

    @Test
    fun `rejects a child cuisine injected into any later candidate`() {
        val groupedContext = context.copy(excludedCuisines = listOf("川湘菜"))
        val candidates = List(3) { index ->
            result().copy(rank = index + 1, resultToken = ('A' + index).toString().repeat(43))
        }
        val validResponse = response(candidates.first()).copy(results = candidates)
        assertTrue(RecommendationResponseValidator.isValid(validResponse, groupedContext))

        for (index in 1..2) {
            val tampered = validResponse.copy(
                results = candidates.mapIndexed { candidateIndex, candidate ->
                    if (candidateIndex == index) candidate.copy(tags = listOf("湘菜")) else candidate
                },
            )
            assertFalse(RecommendationResponseValidator.isValid(tampered, groupedContext))
        }
    }

    @Test
    fun `grouped exclusion preserves unrelated tags and unknown facts for confirmation`() {
        val groupedContext = context.copy(excludedCuisines = listOf("川湘菜"))
        for (mode in DataRightsMode.entries) {
            for (tags in listOf(emptyList(), listOf("未知菜系"), listOf("面食", "中式快餐"))) {
                val candidate = result().copy(
                    tags = tags,
                    averageCostYuan = null,
                    openStatus = OpenStatus.UNKNOWN,
                    warnings = listOf("菜系、价格和营业状态待确认"),
                )
                assertTrue(
                    "$mode: $tags",
                    RecommendationResponseValidator.isValid(
                        response(candidate).copy(dataRightsMode = mode),
                        groupedContext,
                    ),
                )
            }
        }
    }

    @Test
    fun `does not turn soft time guidance or unknown facts into hard rejection`() {
        val uncertain = result().copy(
            sourceRating = null,
            averageCostYuan = null,
            estimatedTravelMinutes = 45.0,
            estimatedMealMinutes = 60.0,
            openStatus = OpenStatus.UNKNOWN,
            tags = emptyList(),
            confidence = Confidence.LOW,
            warnings = listOf("营业时间待确认", "预计时间可能超出预算"),
        )

        assertTrue(isValid(uncertain))
    }

    @Test
    fun `does not apply a budget ceiling when the request has no hard budget`() {
        val noBudget = context.copy(budgetMaxYuan = null)
        val expensive = result().copy(averageCostYuan = 8_888.0)

        assertTrue(RecommendationResponseValidator.isValid(response(expensive), noBudget))
    }

    @Test
    fun `requires a target matching versioned profile for specialty responses`() {
        val coffeeContext = context.copy(target = RecommendationTarget.COFFEE)
        val coffeeProfile = RecommendationProfile(
            target = RecommendationTarget.COFFEE,
            family = RecommendationProfileFamily.COFFEE,
            version = "coffee-v1",
            providerCapabilityRequired = true,
        )

        assertTrue(
            RecommendationResponseValidator.isValid(
                response(result()).copy(profile = coffeeProfile),
                coffeeContext,
            ),
        )
        assertFalse(
            RecommendationResponseValidator.isValid(response(result()), coffeeContext),
        )
        assertFalse(
            RecommendationResponseValidator.isValid(
                response(result()).copy(profile = coffeeProfile.copy(version = "meal-lunch-v1")),
                coffeeContext,
            ),
        )
    }

    @Test
    fun `legacy profile is accepted only for the lunch baseline`() {
        assertTrue(isValid(result()))
        for (period in listOf(MealPeriod.BREAKFAST, MealPeriod.DINNER)) {
            assertFalse(
                RecommendationResponseValidator.isValid(
                    response(result()),
                    context.copy(mealPeriod = period),
                ),
            )
        }
    }

    @Test
    fun `rules only request rejects any AI usage claim`() {
        assertFalse(
            RecommendationResponseValidator.isValid(
                response(result()).copy(aiFallbackUsed = true),
                context,
            ),
        )
        assertFalse(isValid(result().copy(aiAssisted = true)))
    }

    @Test
    fun `requires exact user reported weather echo and query modifier`() {
        val weatherContext = context.copy(
            weatherContext = WeatherContextRequest(
                kind = WeatherContextKind.USER_REPORTED,
                preference = UserReportedWeatherPreference.COOLING,
            ),
        )
        val response = response(result()).copy(
            profile = RecommendationProfile(
                target = RecommendationTarget.MEAL,
                family = RecommendationProfileFamily.MEAL_LUNCH,
                version = "meal-lunch-v1",
                providerCapabilityRequired = false,
            ),
            weatherApplication = WeatherApplication(
                kind = WeatherApplicationKind.USER_REPORTED,
                version = "user-reported-weather-v1",
                preference = UserReportedWeatherPreference.COOLING,
                queryModifier = WeatherQueryModifier.PREFER_COOLING_OPTIONS,
            ),
        )

        assertTrue(RecommendationResponseValidator.isValid(response, weatherContext))
        assertFalse(
            RecommendationResponseValidator.isValid(
                response.copy(
                    weatherApplication = response.weatherApplication.copy(
                        queryModifier = WeatherQueryModifier.PREFER_WARMING_OPTIONS,
                    ),
                ),
                weatherContext,
            ),
        )
    }

    @Test
    fun `accepts unknown well formed provider code without inferring its coordinate system`() {
        assertTrue(
            isValid(
                result().copy(
                    provider = "LOCAL_PARTNER_7",
                    location = result().location.copy(crs = CoordinateReferenceSystem.GCJ02),
                ),
            ),
        )
        assertTrue(
            isValid(
                result().copy(
                    provider = "LOCAL_PARTNER_7",
                    location = result().location.copy(crs = CoordinateReferenceSystem.WGS84),
                ),
            ),
        )
    }

    @Test
    fun `accepts exactly 43 base64url characters as an opaque result token`() {
        assertTrue(isValid(result().copy(resultToken = "abcdefghijklmnopqrstuvwxyzABCDEFGH0123456_-")))
    }

    @Test
    fun `rejects result tokens with invalid length or characters`() {
        listOf(
            "A".repeat(42),
            "A".repeat(44),
            "A".repeat(42) + "+",
            "A".repeat(42) + "/",
            "A".repeat(42) + "=",
            "A".repeat(42) + " ",
        ).forEach { token ->
            assertFalse(isValid(result().copy(resultToken = token)))
        }
    }

    @Test
    fun `rejects duplicate opaque tokens within one response`() {
        val first = result()
        val second = first.copy(rank = 2, name = "另一家餐厅", address = "北京市测试路 2 号")

        assertFalse(
            RecommendationResponseValidator.isValid(
                response(first).copy(results = listOf(first, second)),
                context,
            ),
        )
    }

    @Test
    fun `rejects malformed provider codes but permits disabled capabilities`() {
        listOf("A", "amap", "AMAP-DIRECT", "A".repeat(33)).forEach { provider ->
            assertFalse(isValid(result().copy(provider = provider)))
        }
        assertTrue(
            isValid(
                result().copy(
                    provider = "PARTNER_2",
                    actions = RecommendationActions(false, false, false, false),
                ),
            ),
        )
    }

    private fun isValid(result: RecommendationResult): Boolean =
        RecommendationResponseValidator.isValid(response(result), context)

    private fun response(result: RecommendationResult) = RecommendationResponse(
        requestId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
        generatedAt = "2026-08-20T04:00:00Z",
        coverage = Coverage.NATIONWIDE,
        dataRightsMode = DataRightsMode.LIVE_DISPLAY_ONLY,
        ruleVersion = "rule-v1",
        promptVersion = "prompt-v1",
        modelVersion = "rule-fallback",
        aiFallbackUsed = false,
        results = listOf(result),
        notice = null,
    )

    private fun result() = RecommendationResult(
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
        location = Coordinate(
            latitude = 39.99,
            longitude = 116.31,
            crs = CoordinateReferenceSystem.WGS84,
        ),
        reasons = listOf(RecommendationReason(ReasonCode.DISTANCE_FIT, "距离符合要求")),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "演示数据",
    )
}
