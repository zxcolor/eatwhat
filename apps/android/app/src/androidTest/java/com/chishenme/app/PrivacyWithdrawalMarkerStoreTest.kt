package com.chishenme.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.chishenme.app.feature.consent.PrivacyWithdrawalMarkerStore
import java.io.File
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrivacyWithdrawalMarkerStoreTest {
    private lateinit var context: Context

    @Before
    fun resetBeforeTest() {
        context = ApplicationProvider.getApplicationContext()
        resetMarkerStorage()
    }

    @After
    fun resetAfterTest() {
        resetMarkerStorage()
    }

    @Test
    fun markerIsFailClosedAndSurvivesStoreReconstruction() {
        val first = PrivacyWithdrawalMarkerStore(context)
        assertTrue("missing marker state must be fail-closed", first.isBlocked())

        assertTrue("explicit acceptance must persist both allow channels", first.clear())
        assertFalse(first.isBlocked())
        assertFalse(PrivacyWithdrawalMarkerStore(context).isBlocked())

        assertTrue("withdrawal must invalidate at least one durable allow channel", first.block())
        assertTrue(first.isBlocked())
        assertTrue(PrivacyWithdrawalMarkerStore(context).isBlocked())
    }

    private fun resetMarkerStorage() {
        context.deleteSharedPreferences(PREFERENCES_FILE)
        File(context.noBackupFilesDir, ALLOW_MARKER_FILE).delete()
        File(context.noBackupFilesDir, "$ALLOW_MARKER_FILE.tmp").delete()
    }

    private companion object {
        const val PREFERENCES_FILE = "privacy_withdrawal_gate_v1"
        const val ALLOW_MARKER_FILE = "privacy_consent_allow_v1"
    }
}
