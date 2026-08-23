package com.chishenme.app.domain

sealed interface AppVersionStatus {
    data class UpdateRequired(val minimumVersion: String) : AppVersionStatus

    data class Compatible(val minimumVersion: String) : AppVersionStatus

    data object ConfigurationUnavailable : AppVersionStatus
}

object AppVersionPolicy {
    fun evaluate(currentVersion: String, minimumVersion: String?): AppVersionStatus {
        val minimum = minimumVersion?.takeIf(::isStrictVersion)
            ?: return AppVersionStatus.ConfigurationUnavailable
        return if (compare(currentVersion, minimum) < 0) {
            AppVersionStatus.UpdateRequired(minimum)
        } else {
            AppVersionStatus.Compatible(minimum)
        }
    }

    fun isBelow(currentVersion: String, minimumVersion: String): Boolean =
        isStrictVersion(minimumVersion) && compare(currentVersion, minimumVersion) < 0

    private fun compare(left: String, right: String): Int {
        val leftParts = normalizedParts(left)
        val rightParts = normalizedParts(right)
        return leftParts.indices.firstNotNullOfOrNull { index ->
            compareNumericSegment(leftParts[index], rightParts[index]).takeIf { it != 0 }
        } ?: 0
    }

    private fun normalizedParts(value: String): List<String> = value
        .substringBefore('-')
        .split('.')
        .take(3)
        .map { segment ->
            segment.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }
                ?.trimStart('0')
                ?.ifEmpty { "0" }
                ?: "0"
        }
        .let { it + List(3 - it.size) { "0" } }

    private fun compareNumericSegment(left: String, right: String): Int =
        left.length.compareTo(right.length).takeIf { it != 0 }
            ?: left.compareTo(right)

    private fun isStrictVersion(value: String): Boolean =
        value.matches(Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$"))
}
