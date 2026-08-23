package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.RecommendationResult
import java.nio.charset.StandardCharsets

internal data class RestaurantUriAction(
    val uri: String,
)

internal data class RestaurantClipboardAction(
    val label: String,
    val text: String,
)

/**
 * Builds the minimum data needed for an Android external action without
 * depending on Android framework classes, so every outbound field is unit
 * testable before it reaches an Intent.
 */
internal object RestaurantActionFactory {
    fun navigation(result: RecommendationResult): RestaurantUriAction? {
        return navigation(result.toRestaurantDisplayModel())
    }

    fun navigation(result: RestaurantDisplayModel): RestaurantUriAction? {
        val availability = RestaurantActionAvailabilityPolicy.evaluate(result)
        if (!availability.navigate.enabled) return null
        val query = listOfNotNull(result.name, result.address)
            .map(::inlineText)
            .filter { it.isNotBlank() }
            .joinToString(" ")
            .takeIf(String::isNotBlank)
            ?: return null

        // RFC 5870 geo coordinates are WGS84. Provider POIs may be GCJ02, so
        // never insert result.location here. A neutral origin asks the map app
        // to geocode the user-visible name/address query in its own data set.
        return RestaurantUriAction(uri = "geo:0,0?q=${encodeUriComponent(query)}")
    }

    fun dial(result: RecommendationResult): RestaurantUriAction? {
        return dial(result.toRestaurantDisplayModel())
    }

    fun dial(result: RestaurantDisplayModel): RestaurantUriAction? {
        val availability = RestaurantActionAvailabilityPolicy.evaluate(result)
        if (!availability.call.enabled) return null
        val normalized = result.phone
            ?.let(::inlineText)
            ?.takeIf { value -> value.isNotBlank() && value.any(Char::isDigit) }
            ?: return null
        return RestaurantUriAction(uri = "tel:${encodeUriComponent(normalized)}")
    }

    fun clipboard(result: RecommendationResult): RestaurantClipboardAction? {
        return clipboard(result.toRestaurantDisplayModel())
    }

    fun clipboard(result: RestaurantDisplayModel): RestaurantClipboardAction? {
        val availability = RestaurantActionAvailabilityPolicy.evaluate(result)
        if (!availability.copyAddress.enabled) return null
        val address = result.address?.let(::inlineText)?.takeIf { it.isNotBlank() } ?: return null
        return RestaurantClipboardAction(label = "餐厅地址", text = address)
    }

    fun shareText(result: RestaurantDisplayModel): String? {
        if (!RestaurantActionAvailabilityPolicy.evaluate(result).share.enabled) return null
        return buildList {
            add(inlineText(result.name))
            result.address?.let(::inlineText)?.takeIf(String::isNotBlank)?.let(::add)
            add("数据来源：${inlineText(result.sourceLabel)}")
        }.filter(String::isNotBlank).joinToString("\n").takeIf(String::isNotBlank)
    }
}

private fun inlineText(value: String): String = value
    .trim()
    .replace(Regex("\\s+"), " ")

private fun encodeUriComponent(value: String): String = buildString {
    value.toByteArray(StandardCharsets.UTF_8).forEach { byte ->
        val code = byte.toInt() and 0xff
        if (
            code in 'a'.code..'z'.code ||
            code in 'A'.code..'Z'.code ||
            code in '0'.code..'9'.code ||
            code == '-'.code || code == '.'.code || code == '_'.code || code == '~'.code
        ) {
            append(code.toChar())
        } else {
            append('%')
            append(HEX_DIGITS[code ushr 4])
            append(HEX_DIGITS[code and 0x0f])
        }
    }
}

private const val HEX_DIGITS = "0123456789ABCDEF"
