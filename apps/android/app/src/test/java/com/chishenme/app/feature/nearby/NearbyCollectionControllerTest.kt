package com.chishenme.app.feature.nearby

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.location.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NearbyCollectionControllerTest {
    @Test fun `local collection preserves reported accuracy beyond recommendation wire bounds`() = runTest {
        var accuracy: Double? = null
        val controller = NearbyCollectionController(this, object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult = success.copy(
                fix = success.fix.copy(accuracyMeters = 15_000.0), access = LocationAccess.APPROXIMATE,
            )
        }, { true }, { choice, _, _ -> accuracy = choice.coordinate.accuracyMeters; false })
        controller.open(1000); controller.configure(true, true); advanceUntilIdle()
        assertEquals(15_000.0, accuracy!!, 0.0)
        assertNull(controller.state.value.location!!.coordinate.accuracyMeters)
        assertTrue(controller.state.value.location!!.isApproximate)
    }
    @Test fun `config refresh cancels collection without silently fetching another two pages`() = runTest {
        var collections = 0
        val controller = NearbyCollectionController(this, object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult = success
        }, { true }, { _, _, _ -> collections++; awaitCancellation() })
        controller.open(1000); controller.configure(true, true); runCurrent()
        assertEquals(NearbyPhase.COLLECTING, controller.state.value.phase)
        controller.configure(false, true); controller.configure(true, true); advanceUntilIdle()
        assertEquals(1, collections)
    }
    private val success = ForegroundLocationResult.Success(
        LocationFix(39.9, 116.4, 15.0, CoordinateReferenceSystem.WGS84), LocationAccess.PRECISE,
    )
    @Test fun `consent and permission are both required before locating or collecting`() = runTest {
        var calls = 0
        var collections = 0
        val client = object : ForegroundLocationClient { override suspend fun currentLocation(): ForegroundLocationResult { calls++; return success } }
        val controller = NearbyCollectionController(this, client, { false }, { _, _, _ -> collections++; false })
        controller.open(1000)
        controller.configure(true, false)
        runCurrent()
        assertEquals(NearbyPhase.PERMISSION, controller.state.value.phase)
        assertEquals(0, calls)
        controller.permissionResult(true)
        advanceUntilIdle()
        assertEquals(0, calls)
        assertEquals(0, collections)
    }
    @Test fun `five retries finish before reminder and never collect on failure`() = runTest {
        var calls = 0
        val controller = NearbyCollectionController(this, object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult { calls++; return ForegroundLocationResult.Failure(LocationFailure.TIMEOUT) }
        }, { true }, { _, _, _ -> error("Must not collect") })
        controller.open(1000)
        controller.configure(true, true)
        runCurrent()
        assertEquals(1, calls)
        assertEquals(NearbyPhase.LOCATING, controller.state.value.phase)
        advanceTimeBy(4999)
        runCurrent()
        assertEquals(5, calls)
        assertEquals(NearbyPhase.LOCATING, controller.state.value.phase)
        advanceUntilIdle()
        assertEquals(6, calls)
        assertEquals(NearbyPhase.FAILED, controller.state.value.phase)
        assertEquals(6, controller.state.value.attempt)
    }
    @Test fun `successful retry stops retries and collects once for the opening`() = runTest {
        var calls = 0
        val openings = mutableListOf<Long>()
        val controller = NearbyCollectionController(this, object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult = if (++calls < 3) ForegroundLocationResult.Failure(LocationFailure.UNAVAILABLE) else success
        }, { true }, { _, started, progress -> openings += started; progress(49); true })
        controller.open(1000)
        controller.configure(true, true)
        advanceUntilIdle()
        controller.configure(true, true)
        controller.open(2000) // Composition recreation is not a new opening.
        advanceUntilIdle()
        assertEquals(3, calls)
        assertEquals(listOf(1000L), openings)
        assertEquals(49, controller.state.value.count)
        assertTrue(controller.state.value.limited)
    }
    @Test fun `permission loss returns immediately without location retries`() = runTest {
        var calls = 0
        val controller = NearbyCollectionController(this, object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult { calls++; return ForegroundLocationResult.Failure(LocationFailure.PERMISSION_DENIED) }
        }, { true }, { _, _, _ -> error("Must not collect") })
        controller.open(1000); controller.configure(true, true); advanceUntilIdle()
        assertEquals(1, calls)
        assertEquals(NearbyPhase.PERMISSION, controller.state.value.phase)
    }
    @Test fun `backgrounding cancels retries with no reminder or collection`() = runTest {
        var calls = 0
        val controller = NearbyCollectionController(this, object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult { calls++; return ForegroundLocationResult.Failure(LocationFailure.TIMEOUT) }
        }, { true }, { _, _, _ -> error("Must not collect") })
        controller.open(1000); controller.configure(true, true); runCurrent()
        controller.stop(); advanceUntilIdle()
        assertEquals(1, calls)
        assertNotEquals(NearbyPhase.FAILED, controller.state.value.phase)
    }
    @Test fun `another opening gets another timestamp`() = runTest {
        val times = mutableListOf<Long>()
        val controller = NearbyCollectionController(this, object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult = success
        }, { true }, { _, time, _ -> times += time; false })
        controller.open(1000); controller.configure(true, true); advanceUntilIdle()
        controller.stop(); controller.open(1000); controller.configure(true, true); advanceUntilIdle()
        assertEquals(2, times.size)
        assertTrue(times[1] > times[0])
    }
}
