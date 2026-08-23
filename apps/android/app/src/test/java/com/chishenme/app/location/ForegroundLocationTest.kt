package com.chishenme.app.location

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundLocationTest {
    @Test
    fun `maps precise fix without exposing an address label`() {
        val choice = ForegroundLocationMapper.toLocationChoice(
            fix = LocationFix(39.9928, 116.3109, 18.5, CoordinateReferenceSystem.WGS84),
            access = LocationAccess.PRECISE,
        )

        requireNotNull(choice)
        assertEquals("我的当前位置", choice.label)
        assertEquals(39.9928, choice.coordinate.latitude, 0.00001)
        assertEquals(116.3109, choice.coordinate.longitude, 0.00001)
        assertEquals(18.5, choice.coordinate.accuracyMeters!!, 0.001)
        assertEquals(CoordinateReferenceSystem.WGS84, choice.coordinate.crs)
        assertFalse(choice.isApproximate)
        assertFalse(choice.isDemonstration)
    }

    @Test
    fun `keeps approximate-only location usable and marked`() {
        val choice = ForegroundLocationMapper.toLocationChoice(
            fix = LocationFix(39.99, 116.31, 2_500.0, CoordinateReferenceSystem.WGS84),
            access = LocationAccess.APPROXIMATE,
        )

        requireNotNull(choice)
        assertEquals("我的大致位置", choice.label)
        assertTrue(choice.isApproximate)
        assertEquals(2_500.0, choice.coordinate.accuracyMeters!!, 0.001)
    }

    @Test
    fun `omits unusable accuracy instead of sending a value rejected by the API`() {
        val choice = ForegroundLocationMapper.toLocationChoice(
            fix = LocationFix(39.99, 116.31, 10_001.0, CoordinateReferenceSystem.WGS84),
            access = LocationAccess.APPROXIMATE,
        )

        requireNotNull(choice)
        assertNull(choice.coordinate.accuracyMeters)
    }

    @Test
    fun `rejects invalid framework coordinates`() {
        assertNull(
            ForegroundLocationMapper.toLocationChoice(
                fix = LocationFix(91.0, 116.31, 10.0, CoordinateReferenceSystem.WGS84),
                access = LocationAccess.PRECISE,
            ),
        )
        assertNull(
            ForegroundLocationMapper.toLocationChoice(
                fix = LocationFix(39.99, Double.NaN, 10.0, CoordinateReferenceSystem.WGS84),
                access = LocationAccess.PRECISE,
            ),
        )
    }

    @Test
    fun `permanent denial and disabled provider point to different settings`() {
        assertEquals(
            LocationSettingsTarget.APP,
            LocationFailure.PERMISSION_PERMANENTLY_DENIED.presentation().settingsTarget,
        )
        assertEquals(
            LocationSettingsTarget.DEVICE_LOCATION,
            LocationFailure.PROVIDER_DISABLED.presentation().settingsTarget,
        )
        assertEquals(
            LocationSettingsTarget.NONE,
            LocationFailure.TIMEOUT.presentation().settingsTarget,
        )
    }
}
