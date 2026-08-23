package com.chishenme.app.data.remote

import kotlinx.serialization.Serializable

@Serializable
enum class FavoriteGroup { WANT_TO_GO, REGULAR }

@Serializable
enum class PersistedPresentationStatus {
    AVAILABLE,
    TEMPORARILY_UNAVAILABLE,
    RIGHTS_REVOKED,
}

/**
 * A server-resolved, non-durable presentation projection.
 *
 * The public contract intentionally has no provider place ID, coordinates, phone, image URL,
 * outbound action or recommendation result token. Android keeps this object only in memory.
 */
@Serializable
data class PersistedPlacePresentation(
    val presentationStatus: PersistedPresentationStatus,
    val name: String? = null,
    val address: String? = null,
    val sourceLabel: String? = null,
    val dataMode: RecommendationDataMode? = null,
    val openStatus: OpenStatus? = null,
    val averageCostYuan: Double? = null,
    val tags: List<String>? = null,
    val resolvedAt: String? = null,
    val retryable: Boolean? = null,
)

@Serializable
data class RecommendationResultReferenceInput(
    val requestId: String,
    val resultToken: String,
)

@Serializable
data class FavoriteMutationRequest(
    val idempotencyKey: String,
    val result: RecommendationResultReferenceInput,
    val group: FavoriteGroup,
)

@Serializable
data class UpdateFavoriteGroupRequest(
    val idempotencyKey: String,
    val group: FavoriteGroup,
)

@Serializable
data class FavoriteRecord(
    val favoriteId: String,
    val group: FavoriteGroup,
    val createdAt: String,
    val presentation: PersistedPlacePresentation,
)

@Serializable
data class FavoritesPage(
    val items: List<FavoriteRecord>,
    val nextCursor: String?,
)

@Serializable
enum class RecommendationHistoryAction {
    RECOMMENDATION_SHOWN,
    DETAIL_VIEWED,
    FAVORITE_ADDED,
    NAVIGATION_OPENED,
    PHONE_DIALER_OPENED,
    REROLL_REQUESTED,
}

@Serializable
data class RecommendationHistoryItem(
    val historyId: String,
    val action: RecommendationHistoryAction,
    val mealPeriod: MealPeriod,
    val occurredAt: String,
    val expiresAt: String,
    val presentation: PersistedPlacePresentation?,
)

@Serializable
data class RecommendationHistoryPage(
    val items: List<RecommendationHistoryItem>,
    val nextCursor: String?,
    val retentionDays: Int,
)

@Serializable
enum class PrivateFeedbackType {
    WANT_TO_EAT,
    ATE,
    LIKE,
    DISLIKE,
    TOO_FAR,
    TOO_EXPENSIVE,
    RECENTLY_ATE,
    AVOID_CUISINE,
}

@Serializable
data class CreatePrivateFeedbackRequest(
    val idempotencyKey: String,
    val result: RecommendationResultReferenceInput,
    val type: PrivateFeedbackType,
)

@Serializable
data class PrivateFeedbackRecord(
    val feedbackId: String,
    val type: PrivateFeedbackType,
    val visibility: String,
    val createdAt: String,
    val presentation: PersistedPlacePresentation?,
)

@Serializable
data class PrivateFeedbackPage(
    val items: List<PrivateFeedbackRecord>,
    val nextCursor: String?,
)

@Serializable
data class PersistenceCapabilities(
    val favoritesEnabled: Boolean,
    val historyEnabled: Boolean,
    val privateFeedbackEnabled: Boolean,
    val savedResourceIdsEnabled: Boolean,
) {
    companion object {
        val Disabled = PersistenceCapabilities(
            favoritesEnabled = false,
            historyEnabled = false,
            privateFeedbackEnabled = false,
            savedResourceIdsEnabled = false,
        )
    }
}
