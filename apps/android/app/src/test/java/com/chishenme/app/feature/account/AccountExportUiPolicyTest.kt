package com.chishenme.app.feature.account

import com.chishenme.app.data.remote.AccountExportApi
import com.chishenme.app.data.remote.AccountExportContentApi
import com.chishenme.app.data.remote.AccountExportStatusResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Streaming

class AccountExportUiPolicyTest {
    @Test
    fun `download transport is a streaming bearer endpoint without URL grants`() {
        val content = AccountExportContentApi::class.java.declaredMethods.single { it.name == "exportContent" }
        val get = requireNotNull(content.getAnnotation(GET::class.java))
        assertEquals("v1/account/exports/{exportId}/content", get.value)
        assertTrue(content.isAnnotationPresent(Streaming::class.java))
        assertTrue(
            content.parameterAnnotations.flatten()
                .filterIsInstance<Header>()
                .any { it.value == "Authorization" },
        )

        val allMethods = AccountExportContentApi::class.java.declaredMethods.toList() +
            AccountExportApi::class.java.declaredMethods
        assertFalse(allMethods.any { it.name.contains("grant", ignoreCase = true) })
        assertFalse(allMethods.any { it.name.contains("url", ignoreCase = true) })
        assertEquals(1, allMethods.count { it.isAnnotationPresent(POST::class.java) })
    }

    @Test
    fun `UI formatting never displays a full checksum`() {
        val checksum = "0123456789abcdef".repeat(4)

        val summary = checksumSummary(checksum)

        assertEquals("0123456789ab…89abcdef", summary)
        assertFalse(summary.contains(checksum))
        assertEquals("1.0 KB", formatFileSize(1_024))
        assertEquals("1.0 MB", formatFileSize(1_048_576))
    }

    @Test
    fun `status and UI state contain no download URL token locator or destination URI`() {
        val names = AccountExportStatusResponse::class.java.declaredFields.map { it.name.lowercase() } +
            AccountUiState::class.java.declaredFields.map { it.name.lowercase() }

        assertFalse(names.any { it.contains("url") })
        assertFalse(names.any { it.contains("token") })
        assertFalse(names.any { it.contains("locator") })
        assertFalse(names.any { it.contains("destination") })
        assertFalse(names.any { it == "uri" || it.endsWith("uri") })
    }

    @Test
    fun `export controls require both current server and view model capability`() {
        assertFalse(showAccountExportControls(false, false))
        assertFalse(showAccountExportControls(false, true))
        assertFalse(showAccountExportControls(true, false))
        assertTrue(showAccountExportControls(true, true))
    }
}
