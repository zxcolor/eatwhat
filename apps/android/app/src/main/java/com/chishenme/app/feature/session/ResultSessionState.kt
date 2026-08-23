package com.chishenme.app.feature.session

/**
 * Live validity of an in-memory restaurant-result session.
 *
 * A result is actionable only while it still belongs to the current ViewModel
 * response and the foreground configuration is not being re-confirmed.
 */
enum class ResultSessionState {
    CURRENT,
    CONFIG_UNCONFIRMED,
    EXPIRED,
}
