package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationResult
import java.util.Locale
import kotlin.math.roundToInt

/**
 * The complete allow-list of text that may leave the app on a share card.
 *
 * Keeping this model independent from Android drawing and Intent classes makes
 * the privacy boundary deterministic and unit testable. In particular, it has
 * no field for resultToken, provider identifiers, coordinates, phone numbers,
 * request IDs, rule/model versions or remote images.
 */
internal data class RestaurantShareCardContent(
    val restaurantName: String,
    val address: String?,
    val facts: List<String>,
    val reasons: List<String>,
    val sourceAttribution: String,
    val aiNotice: String?,
    val dataNotice: String,
    val safetyNotice: String,
) {
    /** Test-only-friendly representation of everything the renderer may draw. */
    fun visibleText(): String = buildList {
        add(restaurantName)
        address?.let(::add)
        addAll(facts)
        addAll(reasons)
        add(sourceAttribution)
        aiNotice?.let(::add)
        add(dataNotice)
        add(safetyNotice)
    }.joinToString("\n")
}

internal object RestaurantShareCardContentFactory {
    fun create(result: RecommendationResult): RestaurantShareCardContent? {
        if (!RestaurantActionAvailabilityPolicy.evaluate(result).share.enabled) return null

        val redactions = sensitiveValues(result)
        fun safe(value: String, maxLength: Int): String = value
            .normalizeInline()
            .redactExact(redactions)
            .redactSensitivePatterns()
            .take(maxLength)
            .trim()

        val restaurantName = safe(result.name, MAX_NAME_LENGTH).ifBlank { "餐厅名称待确认" }
        val address = safe(result.address, MAX_ADDRESS_LENGTH).takeIf(String::isNotBlank)
        val distance = distanceLabel(result.distanceMeters)
        val cost = result.averageCostYuan
            ?.takeIf { it.isFinite() && it >= 0.0 }
            ?.roundToInt()
            ?.let { "参考人均 约 $it 元" }
            ?: "参考人均 暂无可靠信息"
        val openStatus = when (result.openStatus) {
            OpenStatus.OPEN -> "营业中"
            OpenStatus.CLOSED -> "已打烊"
            OpenStatus.UNKNOWN -> "营业状态待确认"
        }
        val facts = listOf("距离 $distance", cost, openStatus)

        val verifiedReasons = buildList {
            result.reasons.asSequence()
                .map { reason -> safe(reason.text, MAX_REASON_LENGTH) }
                .filter(String::isNotBlank)
                .distinct()
                .forEach { reason -> if (size < MAX_REASON_COUNT) add(reason) }

            // The server response itself is the source for these fallbacks;
            // unlike flavor claims, each can be verified from returned facts.
            sequenceOf(
                "距当前位置 $distance",
                result.averageCostYuan
                    ?.takeIf { it.isFinite() && it >= 0.0 }
                    ?.roundToInt()
                    ?.let { "参考人均约 $it 元" },
                result.estimatedTravelMinutes
                    .takeIf { it.isFinite() && it >= 0.0 }
                    ?.roundToInt()
                    ?.let { "预计路程约 $it 分钟" },
                when (result.openStatus) {
                    OpenStatus.OPEN -> "当前标记为营业中"
                    OpenStatus.CLOSED -> "当前标记为已打烊"
                    OpenStatus.UNKNOWN -> null
                },
                when (result.confidence) {
                    Confidence.HIGH -> "服务端标记为信息较完整"
                    Confidence.MEDIUM -> "服务端标记为部分信息待确认"
                    Confidence.LOW -> "服务端标记为信息有限"
                },
            ).filterNotNull()
                .map { reason -> safe(reason, MAX_REASON_LENGTH) }
                .filter(String::isNotBlank)
                .filter { reason -> reason !in this }
                .forEach { reason -> if (size < MAX_REASON_COUNT) add(reason) }
        }.take(MAX_REASON_COUNT)

        val source = safe(result.sourceAttribution, MAX_SOURCE_LENGTH)
            .ifBlank { "来源暂无可靠信息" }
        val aiNotice = if (result.aiAssisted) {
            "AI 辅助推荐 · 结果可能出错，请自行核实"
        } else {
            null
        }
        val dataNotice = if (result.dataMode == RecommendationDataMode.DEMO) {
            "演示数据：不代表真实商户，请勿据此出行或联系"
        } else {
            "当前会话信息：距离、价格和营业状态以本次返回为准"
        }

        return RestaurantShareCardContent(
            restaurantName = restaurantName,
            address = address,
            facts = facts,
            reasons = verifiedReasons,
            sourceAttribution = "数据来源：$source",
            aiNotice = aiNotice,
            dataNotice = dataNotice,
            safetyNotice = "营业、价格及过敏原信息可能变化，出发前请向商户确认。",
        )
    }
}

private fun distanceLabel(distanceMeters: Double): String {
    if (!distanceMeters.isFinite() || distanceMeters < 0.0) return "待确认"
    return if (distanceMeters < 1_000.0) {
        "约 ${distanceMeters.roundToInt()} 米"
    } else {
        "约 ${String.format(Locale.ROOT, "%.1f", distanceMeters / 1_000.0)} 公里"
    }
}

private fun sensitiveValues(result: RecommendationResult): List<String> = buildList {
    add(result.resultToken)
    result.phone?.let(::add)
    add(result.location.latitude.toString())
    add(result.location.longitude.toString())
    add(String.format(Locale.ROOT, "%.6f", result.location.latitude))
    add(String.format(Locale.ROOT, "%.6f", result.location.longitude))
}.map(String::normalizeInline).filter(String::isNotBlank).distinct()

private fun String.redactExact(redactions: List<String>): String = redactions.fold(this) { current, secret ->
    current.replace(secret, "[已隐藏]")
}

private fun String.redactSensitivePatterns(): String = this
    .replace(LABELED_INTERNAL_VALUE_PATTERN, "[内部标识已隐藏]")
    .replace(LABELED_SECRET_PATTERN, "[密钥已隐藏]")
    .replace(LABELED_COORDINATE_PATTERN, "[坐标已隐藏]")
    .replace(PRECISE_DECIMAL_PATTERN, "[坐标已隐藏]")
    .replace(EMAIL_PATTERN, "[邮箱已隐藏]")
    .replace(PHONE_PATTERN, "[电话已隐藏]")
    .replace(UUID_PATTERN, "[请求标识已隐藏]")
    .replace(OPAQUE_TOKEN_PATTERN, "[令牌已隐藏]")

private fun String.normalizeInline(): String = trim().replace(INLINE_WHITESPACE, " ")

private val INLINE_WHITESPACE = Regex("\\s+")
private val LABELED_INTERNAL_VALUE_PATTERN = Regex(
    "(?i)(?:provider[_-]?place[_-]?id|poi[_ -]?id|request[_ -]?id)\\s*[:=：]\\s*\\S+",
)
private val LABELED_SECRET_PATTERN = Regex(
    "(?i)(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token|bearer)\\s*[:=：]?\\s*[A-Za-z0-9._~+/-]{6,}",
)
private val LABELED_COORDINATE_PATTERN = Regex(
    "(?i)(?:latitude|longitude|lat|lon|lng|经度|纬度)\\s*[:=：]?\\s*[+-]?\\d{1,3}(?:\\.\\d+)?",
)
private val PRECISE_DECIMAL_PATTERN = Regex("(?<![\\d.])[+-]?\\d{1,3}\\.\\d{4,}(?![\\d.])")
private val EMAIL_PATTERN = Regex(
    "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
    RegexOption.IGNORE_CASE,
)
private val PHONE_PATTERN = Regex(
    "(?<![\\d.])(?:\\+?86[\\s-]*)?(?:\\(?0\\d{2,3}\\)?[\\s-]*)?(?:\\d[\\s-]*){7,11}(?![\\d.])",
)
private val UUID_PATTERN = Regex(
    "(?i)(?<![A-F0-9])[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}(?![A-F0-9])",
)
private val OPAQUE_TOKEN_PATTERN = Regex(
    "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])",
)
private const val MAX_NAME_LENGTH = 60
private const val MAX_ADDRESS_LENGTH = 120
private const val MAX_REASON_LENGTH = 80
private const val MAX_SOURCE_LENGTH = 100
private const val MAX_REASON_COUNT = 3
