package com.chishenme.app.domain

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CoordinateCrsTransformTest {
    @Test
    fun `WGS84 Beijing control point aligns with the server conversion`() {
        val converted = requireNotNull(
            CoordinateCrsTransform.alignTo(
                latitude = 39.908823,
                longitude = 116.39747,
                source = CoordinateReferenceSystem.WGS84,
                target = CoordinateReferenceSystem.GCJ02,
            ),
        )

        assertEquals(39.9102265, converted.latitude, 0.000001)
        assertEquals(116.4037136, converted.longitude, 0.000001)
        assertEquals(CoordinateReferenceSystem.GCJ02, converted.crs)
    }

    @Test
    fun `same CRS is unchanged and unsupported inverse conversion fails closed`() {
        val unchanged = requireNotNull(
            CoordinateCrsTransform.alignTo(
                latitude = 39.9,
                longitude = 116.4,
                source = CoordinateReferenceSystem.GCJ02,
                target = CoordinateReferenceSystem.GCJ02,
            ),
        )
        assertEquals(39.9, unchanged.latitude, 0.0)
        assertEquals(116.4, unchanged.longitude, 0.0)
        assertNull(
            CoordinateCrsTransform.alignTo(
                latitude = 39.9,
                longitude = 116.4,
                source = CoordinateReferenceSystem.GCJ02,
                target = CoordinateReferenceSystem.WGS84,
            ),
        )
    }
}
