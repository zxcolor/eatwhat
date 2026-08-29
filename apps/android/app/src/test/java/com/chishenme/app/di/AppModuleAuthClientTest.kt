package com.chishenme.app.di

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Test

class AppModuleAuthClientTest {
    @Test
    fun `auth client gets a bounded SMTP margin without changing the shared client`() {
        val shared = OkHttpClient.Builder()
            .readTimeout(8, TimeUnit.SECONDS)
            .callTimeout(10, TimeUnit.SECONDS)
            .build()

        val auth = AppModule.deriveAuthClient(shared)

        assertEquals(8_000, shared.readTimeoutMillis)
        assertEquals(10_000, shared.callTimeoutMillis)
        assertEquals(20_000, auth.readTimeoutMillis)
        assertEquals(20_000, auth.callTimeoutMillis)
    }
}
