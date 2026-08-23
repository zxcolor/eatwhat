package com.chishenme.app.feature.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationPermissionUiStateTest {
    @Test
    fun `empty activity result is cancellation rather than permanent denial`() {
        assertEquals(
            LocationPermissionDenial.CANCELLED,
            classifyLocationPermissionDenial(
                resultWasEmpty = true,
                shouldShowRationale = false,
            ),
        )
    }

    @Test
    fun `explicit denial remains retryable while rationale is available`() {
        assertEquals(
            LocationPermissionDenial.CAN_ASK_AGAIN,
            classifyLocationPermissionDenial(
                resultWasEmpty = false,
                shouldShowRationale = true,
            ),
        )
    }

    @Test
    fun `explicit denial without rationale is treated as permanent`() {
        assertEquals(
            LocationPermissionDenial.PERMANENT,
            classifyLocationPermissionDenial(
                resultWasEmpty = false,
                shouldShowRationale = false,
            ),
        )
    }

    @Test
    fun `precision upgrade is offered only for coarse-only access`() {
        assertTrue(shouldOfferPrecisionUpgrade(coarseGranted = true, fineGranted = false))
        assertFalse(shouldOfferPrecisionUpgrade(coarseGranted = false, fineGranted = false))
        assertFalse(shouldOfferPrecisionUpgrade(coarseGranted = true, fineGranted = true))
    }
}
