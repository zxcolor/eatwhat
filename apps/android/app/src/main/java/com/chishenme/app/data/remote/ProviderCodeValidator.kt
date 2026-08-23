package com.chishenme.app.data.remote

/**
 * Shared wire-level provider identifier policy. A provider code identifies an
 * adapter for diagnostics and event correlation; it never selects UI behavior.
 */
internal object ProviderCodeValidator {
    private val pattern = Regex("^[A-Z][A-Z0-9_]{1,31}$")

    fun isValid(value: String): Boolean = pattern.matches(value)
}
