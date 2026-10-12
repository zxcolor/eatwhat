package com.chishenme.app.feature.home

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.LocationCityApi
import com.chishenme.app.data.remote.LocationCityRequest
import com.chishenme.app.data.remote.LocationCityResponse
import com.chishenme.app.domain.LocationChoice
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeCityViewModelTest {
    @Test
    fun `same coordinate reuses city across label and accuracy changes`() = runTest {
        val api = RecordingCityApi()
        val viewModel = HomeCityViewModel(api)
        val first = location()

        assertEquals("Test City", viewModel.resolve(first))
        assertEquals(
            "Test City",
            viewModel.resolve(first.copy(label = "Different landmark", coordinate = first.coordinate.copy(accuracyMeters = 500.0))),
        )
        assertEquals(1, api.requests.size)
    }

    @Test
    fun `distinct coordinate and coordinate system resolve separately`() = runTest {
        val api = RecordingCityApi()
        val viewModel = HomeCityViewModel(api)
        val first = location()

        viewModel.resolve(first)
        viewModel.resolve(first.copy(coordinate = first.coordinate.copy(latitude = 13.0)))
        viewModel.resolve(first.copy(coordinate = first.coordinate.copy(latitude = 13.0, crs = CoordinateReferenceSystem.GCJ02)))

        assertEquals(3, api.requests.size)
    }

    @Test
    fun `concurrent requests for the same coordinate share the result`() = runTest {
        val release = CompletableDeferred<Unit>()
        val api = RecordingCityApi { release.await(); LocationCityResponse("Test City") }
        val viewModel = HomeCityViewModel(api)
        val first = async { viewModel.resolve(location()) }
        val second = async { viewModel.resolve(location()) }
        runCurrent()
        assertEquals(1, api.requests.size)

        release.complete(Unit)
        assertEquals("Test City", first.await())
        assertEquals("Test City", second.await())
        assertEquals(1, api.requests.size)
    }

    @Test
    fun `privacy clear rejects delayed city and does not retain it for next consent session`() = runTest {
        val release = CompletableDeferred<Unit>()
        val api = RecordingCityApi { release.await(); LocationCityResponse("Test City") }
        val viewModel = HomeCityViewModel(api)
        val pending = async { viewModel.resolve(location()) }
        runCurrent()
        assertEquals(1, api.requests.size)

        viewModel.clear()
        release.complete(Unit)
        assertNull(pending.await())

        assertEquals("Test City", viewModel.resolve(location()))
        assertEquals(2, api.requests.size)
    }

    @Test
    fun `city request contains only coordinate and CRS without accuracy or landmark`() = runTest {
        val api = RecordingCityApi()
        HomeCityViewModel(api).resolve(location())

        val request = api.requests.single()
        val body = Json.parseToJsonElement(Json.encodeToString(request)).jsonObject
        assertEquals(setOf("location"), body.keys)
        assertEquals(setOf("latitude", "longitude", "crs"), body.getValue("location").jsonObject.keys)
        assertEquals(12.25, request.location.latitude, 0.0)
        assertEquals(34.5, request.location.longitude, 0.0)
        assertEquals(CoordinateReferenceSystem.WGS84, request.location.crs)
    }

    private fun location() = LocationChoice(
        label = "Synthetic landmark",
        coordinate = Coordinate(12.25, 34.5, 80.0, CoordinateReferenceSystem.WGS84),
    )

    private class RecordingCityApi(
        private val response: suspend () -> LocationCityResponse = { LocationCityResponse("Test City") },
    ) : LocationCityApi {
        val requests = mutableListOf<LocationCityRequest>()

        override suspend fun city(request: LocationCityRequest): LocationCityResponse {
            requests += request
            return response()
        }
    }
}
