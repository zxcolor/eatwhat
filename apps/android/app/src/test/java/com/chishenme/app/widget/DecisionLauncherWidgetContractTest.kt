package com.chishenme.app.widget

import android.app.PendingIntent
import android.content.Intent
import com.chishenme.app.BuildConfig
import com.chishenme.app.MainActivity
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

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

    @Test
    fun `minimum widget height contains the complete touch target at fractional densities`() {
        val layout = readResourceXml("layout/widget_decision_launcher.xml")
        val provider = readResourceXml("xml/decision_launcher_widget_info.xml")
        val buttons = layout.getElementsByTagName("Button")
        assertEquals("The widget must retain its single explicit launch action", 1, buttons.length)
        val button = buttons.item(0) as Element
        val buttonHeight = button.dpAttribute("layout_height")
        val topPadding = layout.dpAttribute("paddingTop")
        val bottomPadding = layout.dpAttribute("paddingBottom")
        val minimumHeights = listOf(provider.dpAttribute("minHeight"), provider.dpAttribute("minResizeHeight"))

        assertEquals("Do not shrink the accessible action to conceal clipping", 48f, buttonHeight, 0f)
        assertEquals(48f, button.dpAttribute("minHeight"), 0f)
        minimumHeights.forEach { assertEquals("Keep the advertised host size", 72f, it, 0f) }
        // Android rounds each dimension separately. At 420 dpi, the old
        // 12 + 48 + 12 dp rounded to 32 + 126 + 32 = 190 px, exceeding
        // a 72 dp / 189 px host by one pixel despite fitting in dp arithmetic.
        val densityDpis = listOf(120, 160, 200, 213, 240, 280, 320, 360, 400, 420, 440, 480, 560, 640)
        densityDpis.forEach { densityDpi ->
            val density = densityDpi / 160f
            val occupiedPixels = buttonHeight.toDimensionPixels(density) +
                topPadding.toDimensionPixels(density) + bottomPadding.toDimensionPixels(density)
            minimumHeights.forEach { minimumHeight ->
                val availablePixels = minimumHeight.toDimensionPixels(density)
                assertTrue(
                    "At $densityDpi dpi the $availablePixels px host must contain all $occupiedPixels px of the button and padding",
                    availablePixels >= occupiedPixels,
                )
            }
        }
    }

    private fun readResourceXml(relativePath: String): Element {
        // Gradle executes app unit tests from the module directory; also accept
        // Android-project/repository working directories used by local runners.
        val resourceFile = listOf("src/main/res", "app/src/main/res", "apps/android/app/src/main/res")
            .map { File(it, relativePath) }
            .firstOrNull(File::isFile)
            ?: error("Cannot locate the widget resource under the current project: $relativePath")
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }
        return factory.newDocumentBuilder().parse(resourceFile).documentElement
    }

    private fun Element.dpAttribute(name: String): Float {
        val value = getAttributeNS("http://schemas.android.com/apk/res/android", name)
        require(value.matches(Regex("^[0-9]+(?:\\.[0-9]+)?dp$"))) { "$name must be an explicit nonnegative dp dimension" }
        return value.removeSuffix("dp").toFloat()
    }

    private fun Float.toDimensionPixels(density: Float): Int = (this * density + 0.5f).toInt()

    private fun Int.hasFlag(flag: Int): Boolean = this and flag == flag
}
