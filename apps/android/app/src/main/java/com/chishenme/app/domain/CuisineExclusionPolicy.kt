package com.chishenme.app.domain

import java.util.Locale

/**
 * Matches explicit cuisine tags using the server's grouped-choice expansion.
 * No match means no known tag conflict; it does not establish missing cuisine
 * facts or ingredient/allergy safety.
 */
internal object CuisineExclusionPolicy {
    fun hasExcludedCuisine(tags: List<String>, exclusions: List<String>): Boolean {
        if (tags.isEmpty() || exclusions.isEmpty()) return false
        val normalizedExclusions = exclusions
            .map(::normalizeCuisine)
            .filter(String::isNotEmpty)
            .flatMap { cuisine ->
                when (cuisine) {
                    "川湘菜" -> listOf("川湘菜", "川菜", "湘菜")
                    else -> listOf(cuisine)
                }
            }
            .toSet()
        return tags.any { tag ->
            val normalizedTag = normalizeCuisine(tag)
            normalizedTag.isNotEmpty() && normalizedExclusions.any { exclusion ->
                normalizedTag.contains(exclusion)
            }
        }
    }

    private fun normalizeCuisine(value: String): String = value.trim().lowercase(Locale.CHINA)
}
