package com.chishenme.app

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

/** Captures only the synthetic fixture while its app owns the active window. */
internal fun ComposeTestRule.captureUiRefinementScreenshot(fileName: String) {
    require(fileName.matches(Regex("[a-z0-9-]+\\.png")))
    waitForIdle()
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    waitUntil(timeoutMillis = 20_000L) {
        val activeWindow = instrumentation.uiAutomation.rootInActiveWindow
            ?: return@waitUntil false
        assertEquals(
            "A system dialog or another app must not obscure the fixture screenshot",
            instrumentation.targetContext.packageName,
            activeWindow.packageName?.toString(),
        )
        true
    }
    val outputDirectory = File(instrumentation.targetContext.cacheDir, "ui-refinement")
    assertTrue(
        "Unable to create the synthetic screenshot directory",
        outputDirectory.isDirectory || outputDirectory.mkdirs(),
    )
    val outputFile = File(outputDirectory, fileName)
    assertTrue("Unable to remove an earlier fixture screenshot", !outputFile.exists() || outputFile.delete())
    val deadline = SystemClock.uptimeMillis() + 20_000L
    instrumentation.uiAutomation.waitForIdle(500L, 5_000L)
    var previousFrame: Bitmap? = null
    var identicalFrameCount = 0
    try {
        while (SystemClock.uptimeMillis() < deadline) {
            assertEquals(
                "The fixture must remain the active window immediately before capture",
                instrumentation.targetContext.packageName,
                checkNotNull(instrumentation.uiAutomation.rootInActiveWindow).packageName?.toString(),
            )
            val frame = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            var retainedForComparison = false
            try {
                assertEquals(
                    "The fixture must remain the active window immediately after capture",
                    instrumentation.targetContext.packageName,
                    checkNotNull(instrumentation.uiAutomation.rootInActiveWindow).packageName?.toString(),
                )
                val previous = previousFrame
                previousFrame = null
                try {
                    identicalFrameCount = if (previous?.sameAs(frame) == true) {
                        identicalFrameCount + 1
                    } else {
                        1
                    }
                } finally {
                    previous?.recycle()
                }
                previousFrame = frame
                retainedForComparison = true
                if (identicalFrameCount >= 3) {
                    // Only the third consecutive identical visible frame is an acceptance artifact.
                    outputFile.outputStream().use { output ->
                        assertTrue(frame.compress(Bitmap.CompressFormat.PNG, 100, output))
                    }
                    return
                }
            } finally {
                if (!retainedForComparison) frame.recycle()
            }
            SystemClock.sleep(100L)
        }
        throw AssertionError("The fixture screenshot did not become visually stable within 20 seconds")
    } finally {
        previousFrame?.recycle()
    }
}
