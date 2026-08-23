package com.chishenme.app.feature.home

internal enum class LocationPermissionDenial {
    CANCELLED,
    CAN_ASK_AGAIN,
    PERMANENT,
}

/**
 * A cancelled Android permission sheet returns an empty result and may also
 * report no rationale. The empty result must win so a first cancellation is
 * never mislabeled as "don't ask again".
 */
internal fun classifyLocationPermissionDenial(
    resultWasEmpty: Boolean,
    shouldShowRationale: Boolean,
): LocationPermissionDenial = when {
    resultWasEmpty -> LocationPermissionDenial.CANCELLED
    shouldShowRationale -> LocationPermissionDenial.CAN_ASK_AGAIN
    else -> LocationPermissionDenial.PERMANENT
}

internal fun shouldOfferPrecisionUpgrade(
    coarseGranted: Boolean,
    fineGranted: Boolean,
): Boolean = coarseGranted && !fineGranted
