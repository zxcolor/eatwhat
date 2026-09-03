package com.chishenme.app.widget

import android.app.PendingIntent
import android.content.Intent
import com.chishenme.app.BuildConfig
import com.chishenme.app.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DecisionLauncherWidgetContractTest {
    @Test
    fun `launch is app scoped and explicitly targets the existing main activity`() {
        val contract = decisionLauncherWidgetLaunchContract

        assertEquals(
            "${BuildConfig.APPLICATION_ID}.action.OPEN_HOME_FROM_WIDGET",
            contract.action,
        )
        assertEquals(MainActivity::class.java.name, contract.targetActivityClassName)
        assertEquals(
            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
            contract.activityFlags,
        )
        assertFalse(contract.activityFlags.hasFlag(Intent.FLAG_ACTIVITY_CLEAR_TASK))
    }

    @Test
    fun `pending intent is immutable and has a stable replacement identity`() {
        val contract = decisionLauncherWidgetLaunchContract

        assertEquals(
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            contract.pendingIntentFlags,
        )
        assertTrue(contract.pendingIntentFlags.hasFlag(PendingIntent.FLAG_IMMUTABLE))
        assertEquals(11_001, contract.requestCode)
    }

    private fun Int.hasFlag(flag: Int): Boolean = this and flag == flag
}
