package com.chishenme.app.data

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.Coverage
import com.chishenme.app.data.remote.IncompatibleApiContractException
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.PlaceSearchApi
import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchRequest
import com.chishenme.app.data.remote.PlaceSearchResponse
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PlaceSearchRepositoryTest {
    @Test
    fun `contract mismatch is explicit and never exposes request values`() = runTest {
        val repository = PlaceSearchRepository(apiThrowing(IOException("wrapper", IncompatibleApiContractException())))

        val outcome = repository.search(request()) as PlaceSearchOutcome.Failure

        assertEquals(PlaceSearchFailureKind.INCOMPATIBLE_API, outcome.kind)
        assertTrue(outcome.message.contains("更新 App"))
        assertFalse(outcome.message.contains("面"))
        assertFalse(outcome.message.contains("39.9928"))
    }

    @Test
    fun `coroutine cancellation is rethrown`() = runTest {
        val repository = PlaceSearchRepository(apiThrowing(CancellationException("screen stopped")))

        try {
            repository.search(request())
            fail("CancellationException must propagate")
        } catch (_: CancellationException) {
            // Expected: lifecycle cancellation is not rendered as an error.
        }
    }

    @Test
    fun `outside pilot is a distinct outcome`() = runTest {
        val response = PlaceSearchResponse(
            requestId = "11111111-1111-4111-8111-111111111111",
            coverage = Coverage.OUTSIDE_PILOT,
            results = emptyList(),
            notice = "当前位置不在北京四环试点区",
        )
        val repository = PlaceSearchRepository(
            object : PlaceSearchApi {
                override suspend fun search(request: PlaceSearchRequest) = response
            },
        )

        assertTrue(repository.search(request()) is PlaceSearchOutcome.OutsidePilot)
    }

    private fun apiThrowing(error: Exception) = object : PlaceSearchApi {
        override suspend fun search(request: PlaceSearchRequest): PlaceSearchResponse = throw error
    }

    private fun request() = PlaceSearchRequest(
        location = PlaceSearchCoordinate(39.9928, 116.3109, CoordinateReferenceSystem.WGS84),
        mealPeriod = MealPeriod.LUNCH,
        keyword = "面",
        radiusMeters = 1_500,
    )
}
