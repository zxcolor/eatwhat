package com.chishenme.app.data

import com.chishenme.app.data.remote.IncompatibleApiContractException
import com.chishenme.app.data.remote.LocationSearchApi
import com.chishenme.app.data.remote.LocationSearchRequest
import com.chishenme.app.data.remote.LocationSearchResponse
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LocationSearchRepositoryTest {
    @Test
    fun `search maps API contract mismatch to an explicit update message`() = runTest {
        val repository = LocationSearchRepository(
            api = object : LocationSearchApi {
                override suspend fun search(request: LocationSearchRequest): LocationSearchResponse {
                    throw IncompatibleApiContractException()
                }
            },
        )

        val outcome = repository.search("北京大学")

        assertTrue(outcome is LocationSearchOutcome.Failure)
        assertEquals(
            "当前 App 与地点搜索服务版本不兼容，请更新 App 后重试",
            (outcome as LocationSearchOutcome.Failure).message,
        )
    }

    @Test
    fun `search preserves coroutine cancellation`() = runTest {
        val repository = LocationSearchRepository(
            api = object : LocationSearchApi {
                override suspend fun search(request: LocationSearchRequest): LocationSearchResponse {
                    throw CancellationException("chooser closed")
                }
            },
        )

        try {
            repository.search("北京大学")
            fail("CancellationException must propagate")
        } catch (_: CancellationException) {
            // Closing the chooser must cancel the network request without showing an error.
        }
    }

    @Test
    fun `search recognizes a wrapped API contract mismatch`() = runTest {
        val repository = LocationSearchRepository(
            api = object : LocationSearchApi {
                override suspend fun search(request: LocationSearchRequest): LocationSearchResponse {
                    throw IOException("network wrapper", IncompatibleApiContractException())
                }
            },
        )

        val outcome = repository.search("北京大学")

        assertEquals(
            "当前 App 与地点搜索服务版本不兼容，请更新 App 后重试",
            (outcome as LocationSearchOutcome.Failure).message,
        )
    }
}
