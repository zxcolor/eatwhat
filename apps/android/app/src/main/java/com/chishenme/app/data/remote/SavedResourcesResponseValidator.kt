package com.chishenme.app.data.remote

import java.time.Duration
import java.time.Instant

internal object SavedResourcesResponseValidator {
    fun validFavorite(record: FavoriteRecord): Boolean =
        record.favoriteId.isContractUuid() &&
            record.createdAt.isUtcInstant() &&
            validPresentation(record.presentation)

    fun validFavoritesPage(page: FavoritesPage): Boolean =
        page.items.size <= MAX_PAGE_SIZE &&
            page.items.map(FavoriteRecord::favoriteId).distinct().size == page.items.size &&
            page.items.all(::validFavorite) &&
            page.nextCursor.isPageCursorOrNull()

    fun validHistoryPage(page: RecommendationHistoryPage): Boolean =
        page.retentionDays == HISTORY_RETENTION_DAYS &&
            page.items.size <= MAX_PAGE_SIZE &&
            page.items.map(RecommendationHistoryItem::historyId).distinct().size == page.items.size &&
            page.items.all(::validHistoryItem) &&
            page.nextCursor.isPageCursorOrNull()

    fun validPrivateFeedback(record: PrivateFeedbackRecord): Boolean =
        record.feedbackId.isContractUuid() &&
            record.visibility == "PRIVATE" &&
            record.createdAt.isUtcInstant() &&
            (record.presentation?.let(::validPresentation) != false)

    fun validPrivateFeedbackPage(page: PrivateFeedbackPage): Boolean =
        page.items.size <= MAX_PAGE_SIZE &&
            page.items.map(PrivateFeedbackRecord::feedbackId).distinct().size == page.items.size &&
            page.items.all(::validPrivateFeedback) &&
            page.nextCursor.isPageCursorOrNull()

    fun validPresentation(presentation: PersistedPlacePresentation): Boolean = when (
        presentation.presentationStatus
    ) {
        PersistedPresentationStatus.AVAILABLE -> {
            val name = presentation.name
            val source = presentation.sourceLabel
            val tags = presentation.tags
            name.isSafeRequiredText(160) &&
                presentation.address.isSafeOptionalText(240) &&
                source.isSafeRequiredText(80) &&
                presentation.dataMode == RecommendationDataMode.LIVE &&
                presentation.openStatus != null &&
                presentation.averageCostYuan.isValidCostOrNull() &&
                tags != null && tags.size <= 8 && tags.all { it.isSafeRequiredText(40) } &&
                presentation.resolvedAt.isUtcInstant() &&
                presentation.retryable == null
        }

        PersistedPresentationStatus.TEMPORARILY_UNAVAILABLE ->
            presentation.retryable == true && presentation.hasNoAvailableFields()

        PersistedPresentationStatus.RIGHTS_REVOKED ->
            presentation.retryable == false && presentation.hasNoAvailableFields()
    }

    internal fun String.containsSensitivePresentationText(): Boolean =
        OPAQUE_RESULT_TOKEN.containsMatchIn(this) ||
            PHONE.containsMatchIn(this) ||
            EMAIL.containsMatchIn(this) ||
            COORDINATE_PAIR.containsMatchIn(this)

    internal fun String.isContractUuid(): Boolean = CONTRACT_UUID.matches(this)

    internal fun String?.isPageCursorOrNull(): Boolean =
        this?.let(PAGE_CURSOR::matches) ?: true

    private fun validHistoryItem(item: RecommendationHistoryItem): Boolean {
        val occurredAt = item.occurredAt.toUtcInstantOrNull() ?: return false
        val expiresAt = item.expiresAt.toUtcInstantOrNull() ?: return false
        return item.historyId.isContractUuid() &&
            Duration.between(occurredAt, expiresAt) == Duration.ofDays(HISTORY_RETENTION_DAYS.toLong()) &&
            (item.presentation?.let(::validPresentation) != false)
    }

    private fun PersistedPlacePresentation.hasNoAvailableFields(): Boolean =
        name == null &&
            address == null &&
            sourceLabel == null &&
            dataMode == null &&
            openStatus == null &&
            averageCostYuan == null &&
            tags == null &&
            resolvedAt == null

    private fun String?.isSafeRequiredText(maxLength: Int): Boolean = this?.let { value ->
        value.isNotBlank() &&
            value == value.trim() &&
            value.length <= maxLength &&
            !value.containsSensitivePresentationText()
    } ?: false

    private fun String?.isSafeOptionalText(maxLength: Int): Boolean = this?.let { value ->
        value == value.trim() &&
            value.length <= maxLength &&
            !value.containsSensitivePresentationText()
    } ?: true

    private fun Double?.isValidCostOrNull(): Boolean =
        this?.let { it.isFinite() && it in 0.0..20_000.0 } ?: true

    private fun String?.isUtcInstant(): Boolean = toUtcInstantOrNull() != null

    private fun String?.toUtcInstantOrNull(): Instant? {
        val raw = this ?: return null
        if (!UTC_DATE_TIME.matches(raw)) return null
        return runCatching { Instant.parse(raw) }.getOrNull()
    }

    private const val MAX_PAGE_SIZE = 50
    private const val HISTORY_RETENTION_DAYS = 90
    private val PAGE_CURSOR = Regex("^[A-Za-z0-9_-]{43}$")
    private val CONTRACT_UUID = Regex(
        "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|" +
            "00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    )
    private val UTC_DATE_TIME = Regex(
        "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?Z$",
    )
    private val OPAQUE_RESULT_TOKEN = Regex("[A-Za-z0-9_-]{43}")
    private val PHONE = Regex(
        "(?:^|\\D)(?:\\+?86[-\\s]?)?1[3-9](?:[-\\s]?\\d){9}(?:\\D|$)",
    )
    private val EMAIL = Regex("[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.[A-Za-z]{2,}")
    private val COORDINATE_PAIR = Regex(
        "(?:^|[^\\d.])[+-]?\\d{1,3}(?:\\.\\d+)\\s*[,，]\\s*[+-]?\\d{1,3}(?:\\.\\d+)(?:[^\\d.]|$)",
    )
}
