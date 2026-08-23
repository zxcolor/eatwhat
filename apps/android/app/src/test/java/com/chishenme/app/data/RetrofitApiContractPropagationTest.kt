package com.chishenme.app.data

import com.chishenme.app.data.remote.ApiContractInterceptor
import com.chishenme.app.data.remote.RecommendationApi
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.PlaceSearchApi
import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchRequest
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.Retrofit

@OptIn(ExperimentalSerializationApi::class)
class RetrofitApiContractPropagationTest {
    @Test
    fun `Retrofit preserves interceptor contract failure for repository classification`() = runTest {
        val client = OkHttpClient.Builder()
            .addInterceptor(ApiContractInterceptor())
            .addInterceptor(
                Interceptor { chain ->
                    okhttp3.Response.Builder()
                        .request(chain.request())
                        .protocol(Protocol.HTTP_1_1)
                        .code(200)
                        .message("OK")
                        .body("{}".toResponseBody("application/json".toMediaType()))
                        .build()
                },
            )
            .build()
        val api = Retrofit.Builder()
            .baseUrl("https://not-used.invalid/")
            .client(client)
            .addConverterFactory(
                Json { ignoreUnknownKeys = true }
                    .asConverterFactory("application/json".toMediaType()),
            )
            .build()
            .create(RecommendationApi::class.java)

        val outcome = RecommendationRepository(api).featureConfig()

        assertEquals(FeatureConfigOutcome.Incompatible, outcome)
    }

    @Test
    fun `gateway 503 without contract header remains unavailable through Retrofit`() = runTest {
        val client = OkHttpClient.Builder()
            .addInterceptor(ApiContractInterceptor())
            .addInterceptor(
                Interceptor { chain ->
                    okhttp3.Response.Builder()
                        .request(chain.request())
                        .protocol(Protocol.HTTP_1_1)
                        .code(503)
                        .message("Service Unavailable")
                        .body("{}".toResponseBody("application/json".toMediaType()))
                        .build()
                },
            )
            .build()
        val api = Retrofit.Builder()
            .baseUrl("https://not-used.invalid/")
            .client(client)
            .addConverterFactory(
                Json { ignoreUnknownKeys = true }
                    .asConverterFactory("application/json".toMediaType()),
            )
            .build()
            .create(RecommendationApi::class.java)

        val outcome = RecommendationRepository(api).featureConfig()

        assertEquals(FeatureConfigOutcome.Unavailable, outcome)
    }

    @Test
    fun `place search also recognizes a Retrofit wrapped contract failure`() = runTest {
        val client = OkHttpClient.Builder()
            .addInterceptor(ApiContractInterceptor())
            .addInterceptor(
                Interceptor { chain ->
                    okhttp3.Response.Builder()
                        .request(chain.request())
                        .protocol(Protocol.HTTP_1_1)
                        .code(200)
                        .message("OK")
                        .body("{}".toResponseBody("application/json".toMediaType()))
                        .build()
                },
            )
            .build()
        val api = Retrofit.Builder()
            .baseUrl("https://not-used.invalid/")
            .client(client)
            .addConverterFactory(
                Json { ignoreUnknownKeys = true }
                    .asConverterFactory("application/json".toMediaType()),
            )
            .build()
            .create(PlaceSearchApi::class.java)
        val outcome = PlaceSearchRepository(api).search(
            PlaceSearchRequest(
                location = PlaceSearchCoordinate(
                    latitude = 39.9928,
                    longitude = 116.3109,
                    crs = CoordinateReferenceSystem.WGS84,
                ),
                mealPeriod = MealPeriod.LUNCH,
                keyword = "面",
                radiusMeters = 1_500,
            ),
        )

        assertEquals(PlaceSearchFailureKind.INCOMPATIBLE_API, (outcome as PlaceSearchOutcome.Failure).kind)
    }
}
