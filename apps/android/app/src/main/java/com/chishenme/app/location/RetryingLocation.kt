package com.chishenme.app.location

import kotlinx.coroutines.delay

/** Initial attempt plus five retries. Permission loss immediately returns to permission UI. */
internal suspend fun locationWithRetries(
    client: ForegroundLocationClient,
    onAttempt: (Int) -> Unit = {},
): ForegroundLocationResult {
    repeat(6) { index ->
        onAttempt(index + 1)
        val raw = client.currentLocation()
        val result = if (raw is ForegroundLocationResult.Success &&
            ForegroundLocationMapper.toLocationChoice(raw.fix, raw.access) == null) {
            ForegroundLocationResult.Failure(LocationFailure.UNAVAILABLE)
        } else raw
        if (result is ForegroundLocationResult.Success) return result
        val failure = (result as ForegroundLocationResult.Failure).reason
        if (failure == LocationFailure.PERMISSION_DENIED ||
            failure == LocationFailure.PERMISSION_PERMANENTLY_DENIED || index == 5) return result
        delay(1_000)
    }
    error("Unreachable location retry state")
}
