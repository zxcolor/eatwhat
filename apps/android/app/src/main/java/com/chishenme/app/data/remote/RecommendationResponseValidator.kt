package com.chishenme.app.data.remote

import com.chishenme.app.domain.CuisineExclusionPolicy
import java.net.URI
import java.time.Instant
import java.util.UUID

object RecommendationResponseValidator {
    fun isValid(response: RecommendationResponse, context: RecommendationContext): Boolean {
        if (runCatching { UUID.fromString(response.requestId) }.isFailure) return false
        if (runCatching { Instant.parse(response.generatedAt) }.isFailure) return false
        if (response.ruleVersion.isBlank() || response.promptVersion.isBlank() || response.modelVersion.isBlank()) {
            return false
        }
        if (response.results.size > 3) return false
        if (response.notice != null && response.notice.length > 500) return false
        if (!profileMatches(response.profile, context)) return false
        if (!weatherApplicationMatches(response.weatherApplication, context.weatherContext)) return false
        val aiPathAllowed = context.aiAssistanceEnabled &&
            context.target == RecommendationTarget.MEAL &&
            context.mealPeriod == MealPeriod.LUNCH &&
            context.weatherContext.kind == WeatherContextKind.NONE
        if (
            !aiPathAllowed &&
            (response.aiFallbackUsed || response.results.any(RecommendationResult::aiAssisted))
        ) return false

        val resultTokens = mutableSetOf<String>()
        return response.results.withIndex().all { (index, result) ->
            resultTokens.add(result.resultToken) &&
                result.rank == index + 1 &&
                isValid(result, response.dataRightsMode) &&
                respectsRequestConstraints(result, context)
        }
    }

    private fun profileMatches(
        profile: RecommendationProfile,
        context: RecommendationContext,
    ): Boolean {
        if (profile.target != context.target || profile.version.length > 80) return false
        val expectedFamily = when (context.target) {
            RecommendationTarget.MEAL -> when (context.mealPeriod) {
                MealPeriod.BREAKFAST -> RecommendationProfileFamily.MEAL_BREAKFAST
                MealPeriod.LUNCH -> RecommendationProfileFamily.MEAL_LUNCH
                MealPeriod.DINNER -> RecommendationProfileFamily.MEAL_DINNER
            }
            RecommendationTarget.MILK_TEA -> RecommendationProfileFamily.MILK_TEA
            RecommendationTarget.COFFEE -> RecommendationProfileFamily.COFFEE
            RecommendationTarget.DESSERT -> RecommendationProfileFamily.DESSERT
        }
        val familyAllowed = profile.family == expectedFamily ||
            (context.target == RecommendationTarget.MEAL &&
                profile.family == RecommendationProfileFamily.MEAL_LEGACY &&
                context.mealPeriod == MealPeriod.LUNCH &&
                context.weatherContext.kind == WeatherContextKind.NONE)
        if (!familyAllowed) return false
        val expectedCapability = profile.family in setOf(
            RecommendationProfileFamily.MILK_TEA,
            RecommendationProfileFamily.COFFEE,
            RecommendationProfileFamily.DESSERT,
        )
        if (profile.providerCapabilityRequired != expectedCapability) return false
        val versionPrefix = when (profile.family) {
            RecommendationProfileFamily.MEAL_LEGACY -> "meal-legacy"
            RecommendationProfileFamily.MEAL_BREAKFAST -> "meal-breakfast"
            RecommendationProfileFamily.MEAL_LUNCH -> "meal-lunch"
            RecommendationProfileFamily.MEAL_DINNER -> "meal-dinner"
            RecommendationProfileFamily.MILK_TEA -> "milk-tea"
            RecommendationProfileFamily.COFFEE -> "coffee"
            RecommendationProfileFamily.DESSERT -> "dessert"
        }
        return profile.version.matches(Regex("^${Regex.escape(versionPrefix)}-v[1-9]\\d*$"))
    }

    private fun weatherApplicationMatches(
        application: WeatherApplication,
        request: WeatherContextRequest,
    ): Boolean {
        if (application.version.length > 80) return false
        return when (request.kind) {
            WeatherContextKind.NONE ->
                application.kind == WeatherApplicationKind.NONE &&
                    application.preference == null &&
                    application.queryModifier == null &&
                    application.version.matches(Regex("^weather-none-v[1-9]\\d*$"))
            WeatherContextKind.USER_REPORTED -> {
                val expectedModifier = when (request.preference ?: return false) {
                    UserReportedWeatherPreference.MINIMIZE_EXPOSURE ->
                        WeatherQueryModifier.MINIMIZE_OUTDOOR_EXPOSURE
                    UserReportedWeatherPreference.WARMING ->
                        WeatherQueryModifier.PREFER_WARMING_OPTIONS
                    UserReportedWeatherPreference.COOLING ->
                        WeatherQueryModifier.PREFER_COOLING_OPTIONS
                }
                application.kind == WeatherApplicationKind.USER_REPORTED &&
                    application.preference == request.preference &&
                    application.queryModifier == expectedModifier &&
                    application.version.matches(
                        Regex("^user-reported-weather-v[1-9]\\d*$"),
                    )
            }
        }
    }

    private fun respectsRequestConstraints(
        result: RecommendationResult,
        context: RecommendationContext,
    ): Boolean {
        // Recheck only explicit, contract-backed facts. UNKNOWN/null/empty facts
        // remain usable with warnings, and time is a soft ranking signal rather
        // than a server hard filter.
        if (result.openStatus == OpenStatus.CLOSED) return false
        if (result.distanceMeters > context.radiusMeters.toDouble()) return false
        val budget = context.budgetMaxYuan
        val knownCost = result.averageCostYuan
        if (budget != null && knownCost != null && knownCost > budget.toDouble()) return false
        if (CuisineExclusionPolicy.hasExcludedCuisine(result.tags, context.excludedCuisines)) return false
        return true
    }

    private fun isValid(result: RecommendationResult, rightsMode: DataRightsMode): Boolean {
        if (!ProviderCodeValidator.isValid(result.provider)) return false
        if (!ResultTokenValidator.isValid(result.resultToken)) return false
        if (result.name.isBlank() || result.name.length > 120 || result.address.length > 300) return false
        if (rightsMode == DataRightsMode.LIVE_DISPLAY_ONLY && result.fitScore != null) return false
        if (result.fitScore != null && (!result.fitScore.isFinite() || result.fitScore !in 0.0..100.0)) return false
        if (result.sourceRating != null && (!result.sourceRating.isFinite() || result.sourceRating !in 0.0..5.0)) return false
        if (result.averageCostYuan != null && (!result.averageCostYuan.isFinite() || result.averageCostYuan < 0)) return false
        if (!result.distanceMeters.isFinite() || result.distanceMeters < 0) return false
        if (!result.estimatedTravelMinutes.isFinite() || result.estimatedTravelMinutes < 0) return false
        if (!result.estimatedMealMinutes.isFinite() || result.estimatedMealMinutes <= 0) return false
        if (result.location.latitude !in -90.0..90.0 || result.location.longitude !in -180.0..180.0) return false
        if (
            result.location.accuracyMeters?.let { accuracy ->
                !accuracy.isFinite() || accuracy < 0.0 || accuracy > MAX_COORDINATE_ACCURACY_METERS
            } == true
        ) return false
        if (result.reasons.size !in 1..4 || result.reasons.any { it.text.isBlank() || it.text.length > 120 }) return false
        if (result.tags.size > 20 || result.tags.any { it.isBlank() || it.length > 40 }) return false
        if (result.warnings.size > 20 || result.warnings.any { it.length > 200 }) return false
        if (result.sourceAttribution.isBlank() || result.sourceAttribution.length > 100) return false
        if (result.imageUrl != null && !isHttpsUrl(result.imageUrl)) return false
        return true
    }

    private fun isHttpsUrl(value: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()
    }.getOrDefault(false)

    private const val MAX_COORDINATE_ACCURACY_METERS = 10_000.0
}

/**
 * A result token is an opaque 256-bit handle encoded as unpadded base64url.
 * Android validates only its wire shape and never interprets or displays it.
 */
internal object ResultTokenValidator {
    private val pattern = Regex("^[A-Za-z0-9_-]{43}$")

    fun isValid(value: String): Boolean = pattern.matches(value)
}
