package com.chishenme.app.data.remote

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import retrofit2.Retrofit

@OptIn(ExperimentalSerializationApi::class)
class AuthApiAuthorizationHeaderTest {
    @Test
    fun `nullable bearer stays in header and never enters OTP body`() = runTest {
        val captured = mutableListOf<Request>()
        val api = api { request -> captured += request }
        val phoneRequest = PhoneCodeRequest(
            phoneNumber = "+8613800138000",
            purpose = OtpPurpose.LOGIN,
            installationId = "11111111-1111-4111-8111-111111111111",
        )
        val emailBindRequest = EmailCodeRequest(
            email = "user@example.com",
            purpose = OtpPurpose.BIND,
            installationId = "11111111-1111-4111-8111-111111111111",
        )
        val privateToken = "t".repeat(43)
        val privateBearer = "Bearer $privateToken"

        api.requestPhoneCode(null, phoneRequest)
        api.requestEmailCode(privateBearer, emailBindRequest)

        assertEquals(null, captured[0].header("Authorization"))
        assertEquals(privateBearer, captured[1].header("Authorization"))
        captured.forEach { sent ->
            val body = Buffer().also { buffer -> sent.body?.writeTo(buffer) }.readUtf8()
            assertFalse(body.contains(privateBearer))
            assertFalse(body.contains(privateToken))
        }
    }

    private fun api(onRequest: (Request) -> Unit): AuthApi {
        val client = OkHttpClient.Builder()
            .addInterceptor(
                Interceptor { chain ->
                    onRequest(chain.request())
                    okhttp3.Response.Builder()
                        .request(chain.request())
                        .protocol(Protocol.HTTP_1_1)
                        .code(200)
                        .message("OK")
                        .body(
                            """{
                                "challengeId":"22222222-2222-4222-8222-222222222222",
                                "targetType":"PHONE",
                                "maskedTarget":"+86138****8000",
                                "expiresAt":"2026-08-21T04:05:00Z",
                                "resendAvailableAt":"2026-08-21T04:01:00Z"
                            }""".trimIndent().toResponseBody("application/json".toMediaType()),
                        )
                        .build()
                },
            )
            .build()
        val json = Json {
            ignoreUnknownKeys = false
            explicitNulls = false
        }
        return Retrofit.Builder()
            .baseUrl("https://not-used.invalid/")
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(AuthApi::class.java)
    }
}
