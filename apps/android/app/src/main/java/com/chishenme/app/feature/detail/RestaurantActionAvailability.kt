package com.chishenme.app.feature.detail

import com.chishenme.app.BuildConfig
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.feature.session.ResultSessionState

internal data class RestaurantActionStatus(
    val enabled: Boolean,
    val unavailableReason: RestaurantActionUnavailableReason? = null,
) {
    init {
        require(enabled == (unavailableReason == null)) {
            "An enabled action cannot have an unavailable reason"
        }
    }

    fun disabledStateDescription(actionLabel: String): String? = unavailableReason?.let { reason ->
        "${actionLabel}不可用：${reason.accessibilityReason}"
    }
}

internal data class RestaurantActionAvailability(
    val navigate: RestaurantActionStatus,
    val call: RestaurantActionStatus,
    val copyAddress: RestaurantActionStatus,
    val share: RestaurantActionStatus,
) {
    fun pageMessages(): List<String> = buildList {
        add(navigate)
        add(call)
        add(copyAddress)
        if (BuildConfig.SHARE_FEATURE_ENABLED) add(share)
    }.mapNotNull(RestaurantActionStatus::unavailableReason)
        .distinct()
        .map(RestaurantActionUnavailableReason::pageMessage)
}

internal enum class RestaurantActionUnavailableReason(
    val pageMessage: String,
    val accessibilityReason: String,
) {
    SOURCE_NOT_ENABLED(
        pageMessage = "当前数据来源尚未开放部分操作。",
        accessibilityReason = "当前数据来源尚未开放此操作",
    ),
    CONFIG_UNCONFIRMED(
        pageMessage = "正在重新确认数据授权，当前结果暂不可操作。",
        accessibilityReason = "正在重新确认数据授权",
    ),
    SESSION_EXPIRED(
        pageMessage = "本次结果已失效，请重新获取。",
        accessibilityReason = "本次结果已失效",
    ),
    MISSING_NAVIGATION_QUERY(
        pageMessage = "暂无可用于地图查询的可靠名称或地址。",
        accessibilityReason = "暂无可靠名称或地址",
    ),
    MISSING_PHONE(
        pageMessage = "暂无可靠电话，暂时无法联系商户。",
        accessibilityReason = "暂无可靠电话",
    ),
    MISSING_ADDRESS(
        pageMessage = "暂无可靠地址，暂时无法复制。",
        accessibilityReason = "暂无可靠地址",
    ),
}

/**
 * Combines the server-issued capability with the minimum local facts needed
 * to perform each action. Provider identity and data mode intentionally have
 * no effect: only explicit capabilities and user-visible fields are trusted.
 */
internal object RestaurantActionAvailabilityPolicy {
    fun evaluate(
        result: RecommendationResult,
        sessionState: ResultSessionState = ResultSessionState.CURRENT,
    ): RestaurantActionAvailability = evaluate(result.toRestaurantDisplayModel(), sessionState)

    fun evaluate(
        result: RestaurantDisplayModel,
        sessionState: ResultSessionState = ResultSessionState.CURRENT,
    ): RestaurantActionAvailability = RestaurantActionAvailability(
        navigate = status(
            sessionState = sessionState,
            serverEnabled = result.actions.navigate,
            missingFactReason = RestaurantActionUnavailableReason.MISSING_NAVIGATION_QUERY,
            hasRequiredFacts = result.name.hasVisibleText() || result.address.hasVisibleText(),
        ),
        call = status(
            sessionState = sessionState,
            serverEnabled = result.actions.call,
            missingFactReason = RestaurantActionUnavailableReason.MISSING_PHONE,
            hasRequiredFacts = result.phone.hasCallableNumber(),
        ),
        copyAddress = status(
            sessionState = sessionState,
            serverEnabled = result.actions.copyAddress,
            missingFactReason = RestaurantActionUnavailableReason.MISSING_ADDRESS,
            hasRequiredFacts = result.address.hasVisibleText(),
        ),
        share = if (BuildConfig.SHARE_FEATURE_ENABLED) {
            status(
                sessionState = sessionState,
                serverEnabled = result.actions.share,
                missingFactReason = null,
                hasRequiredFacts = true,
            )
        } else {
            RestaurantActionStatus(
                enabled = false,
                unavailableReason = RestaurantActionUnavailableReason.SOURCE_NOT_ENABLED,
            )
        },
    )

    private fun status(
        sessionState: ResultSessionState,
        serverEnabled: Boolean,
        missingFactReason: RestaurantActionUnavailableReason?,
        hasRequiredFacts: Boolean,
    ): RestaurantActionStatus = when {
        sessionState != ResultSessionState.CURRENT -> RestaurantActionStatus(
            enabled = false,
            unavailableReason = when (sessionState) {
                ResultSessionState.CONFIG_UNCONFIRMED ->
                    RestaurantActionUnavailableReason.CONFIG_UNCONFIRMED
                ResultSessionState.EXPIRED -> RestaurantActionUnavailableReason.SESSION_EXPIRED
                ResultSessionState.CURRENT -> error("handled above")
            },
        )
        !serverEnabled -> RestaurantActionStatus(
            enabled = false,
            unavailableReason = RestaurantActionUnavailableReason.SOURCE_NOT_ENABLED,
        )
        !hasRequiredFacts -> RestaurantActionStatus(
            enabled = false,
            unavailableReason = requireNotNull(missingFactReason),
        )
        else -> RestaurantActionStatus(enabled = true)
    }
}

private fun String?.hasVisibleText(): Boolean = this?.isNotBlank() == true

private fun String?.hasCallableNumber(): Boolean = this
    ?.trim()
    ?.takeIf(String::isNotBlank)
    ?.any(Char::isDigit)
    ?: false
