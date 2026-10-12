package com.chishenme.app.data.remote

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import retrofit2.Retrofit

@OptIn(ExperimentalSerializationApi::class)
class LocationCityApiTest {
    @Test
    fun `city request contains only explicit coordinates in POST body and parses unknown city`() = runTest {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
        var responseBody = """{"city":"北京市"}"""
        val client = OkHttpClient.Builder().addInterceptor(ApiContractInterceptor())
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                assertEquals("POST", request.method)
                assertEquals("/v1/location-city", request.url.encodedPath)
                assertEquals(null, request.url.query)
                val buffer = Buffer()
                request.body!!.writeTo(buffer)
                val body = json.parseToJsonElement(buffer.readUtf8()).jsonObject
                assertEquals(setOf("location"), body.keys)
                assertEquals(setOf("latitude", "longitude", "crs"), body.getValue("location").jsonObject.keys)
                assertFalse(request.headers.toString().contains("latitude"))
                okhttp3.Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                    .code(200).message("OK").header("X-ChiShenMe-Contract-Version", "1")
                    .body(responseBody.toResponseBody("application/json".toMediaType())).build()
            }).build()
        val api = Retrofit.Builder().baseUrl("https://not-used.invalid/").client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build().create(LocationCityApi::class.java)
        val request = LocationCityRequest(LocationCityCoordinate(0.0, 0.0, CoordinateReferenceSystem.WGS84))
        assertEquals("北京市", api.city(request).city)
        responseBody = """{"city":null}"""
        assertEquals(null, api.city(request).city)
    }
}
