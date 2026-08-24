package com.chishenme.app.data

import com.chishenme.app.data.remote.ApiContractInterceptor
import com.chishenme.app.data.remote.RecommendationApi
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
}
