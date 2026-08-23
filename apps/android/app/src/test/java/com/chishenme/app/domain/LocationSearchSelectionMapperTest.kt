package com.chishenme.app.domain

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.LocationSearchCoordinate
import com.chishenme.app.data.remote.LocationSearchDataMode
import com.chishenme.app.data.remote.LocationSearchPlace
import com.chishenme.app.data.remote.LocationSearchResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class LocationSearchSelectionMapperTest {
    @Test
    fun `selection retains explicit GCJ02 coordinate without provider metadata`() {
        val responseFromUnknownProvider = LocationSearchResponse(
            requestId = "request-unknown-provider",
            dataSource = "FUTURE_PROVIDER",
            dataMode = LocationSearchDataMode.LIVE,
            results = listOf(
                LocationSearchPlace(
                    name = "中关村",
                    address = "海淀区中关村大街",
                    location = LocationSearchCoordinate(
                        latitude = 39.983,
                        longitude = 116.316,
                        crs = CoordinateReferenceSystem.GCJ02,
                    ),
                    sourceLabel = "地点合作方",
                    providerRank = 1,
                ),
            ),
        )
        val choice = LocationSearchSelectionMapper.toLocationChoice(
            place = responseFromUnknownProvider.results.single(),
            dataMode = responseFromUnknownProvider.dataMode,
        )

        assertEquals("中关村", choice.label)
        assertEquals(CoordinateReferenceSystem.GCJ02, choice.coordinate.crs)
        assertEquals(39.983, choice.coordinate.latitude, 0.0)
        assertEquals(116.316, choice.coordinate.longitude, 0.0)
        assertNull(choice.coordinate.accuracyMeters)
        assertFalse(choice.isDemonstration)
        assertFalse(choice.isApproximate)
    }
}
