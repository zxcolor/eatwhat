package com.chishenme.app.data

import com.chishenme.app.data.remote.*
import com.chishenme.app.data.local.NearbyRetentionMillis
import com.chishenme.app.data.local.nearbySnapshotExpired
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class NearbyResponsePolicyTest {
    @Test fun `wire origin has only coordinates and CRS without accuracy or user fields`() {
        val request = NearbyRestaurantRequest(NearbyRestaurantCoordinate(0.0, 0.0, CoordinateReferenceSystem.WGS84), 1)
        val encoded = Json { encodeDefaults = true }.encodeToString(request)
        assertEquals("{\"location\":{\"latitude\":0.0,\"longitude\":0.0,\"crs\":\"WGS84\"},\"page\":1}", encoded)
    }
    @Test fun `expiry excludes the exact 90 day boundary and future timestamps`() {
        val start = 1000L
        assertFalse(nearbySnapshotExpired(start, start + NearbyRetentionMillis - 1))
        assertTrue(nearbySnapshotExpired(start, start + NearbyRetentionMillis))
        assertTrue(nearbySnapshotExpired(start + 1, start))
    }
    @Test fun `only a forward bounded second page is accepted`() {
        val response = NearbyRestaurantResponse(3500, 90, 1, 2, false, emptyList())
        assertTrue(validNearbyPage(response, 1))
        assertFalse(validNearbyPage(response.copy(nextPage = 1), 1))
        assertFalse(validNearbyPage(response.copy(nextPage = 3), 1))
        assertFalse(validNearbyPage(response.copy(radiusMeters = 3501), 1))
        assertFalse(validNearbyPage(response.copy(retentionDays = 91), 1))
        assertFalse(validNearbyPage(response.copy(page = 2), 1))
        assertFalse(validNearbyPage(response.copy(truncated = true), 1))
        assertTrue(validNearbyPage(response.copy(page = 2, nextPage = null, truncated = true), 2))
    }
    @Test fun `distance hard boundary compares coordinates in the same CRS`() {
        val origin = Coordinate(0.0, 0.0, crs = CoordinateReferenceSystem.WGS84)
        assertTrue(withinNearbyRadius(origin, Coordinate(0.0, 0.031, crs = CoordinateReferenceSystem.GCJ02)))
        assertFalse(withinNearbyRadius(origin, Coordinate(0.0, 0.032, crs = CoordinateReferenceSystem.GCJ02)))
        assertFalse(withinNearbyRadius(origin.copy(latitude = Double.NaN), origin))
    }
}
