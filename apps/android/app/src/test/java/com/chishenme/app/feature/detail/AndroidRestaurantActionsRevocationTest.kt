package com.chishenme.app.feature.detail

import android.content.Intent
import android.content.ContextWrapper
import com.chishenme.app.data.remote.Confidence
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.OpenStatus
import com.chishenme.app.data.remote.RecommendationActions
import com.chishenme.app.data.remote.RecommendationDataMode
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.feature.session.ResultSessionState
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AndroidRestaurantActionsRevocationTest {
    @Test
    fun `expired live gate blocks enabled result before every Android surface`() = runTest {
        val context = OutboundFailingContext()
        val enabled = result()
        val expired = { ResultSessionState.EXPIRED }

        assertFalse(AndroidRestaurantActions.openNavigation(context, enabled, expired))
        assertFalse(AndroidRestaurantActions.dial(context, enabled, expired))
        assertFalse(AndroidRestaurantActions.copyAddress(context, enabled, expired))
        assertFalse(AndroidRestaurantActions.shareText(context, enabled.toRestaurantDisplayModel(), expired))
        assertEquals(RestaurantShareOutcome.NOT_ALLOWED, AndroidRestaurantActions.share(context, enabled, expired))
        assertEquals(0, context.outboundAccesses)
    }

    @Test
    fun `revocation between validation and launch is checked again`() {
        val context = OutboundFailingContext()
        var checks = 0

        assertFalse(
            AndroidRestaurantActions.openNavigation(context, result()) {
                checks += 1
                if (checks == 1) ResultSessionState.CURRENT else ResultSessionState.EXPIRED
            },
        )
        assertEquals(2, checks)
        assertEquals(0, context.outboundAccesses)
    }

    @Test
    fun `revoked result reaches no Android outbound surface`() = runTest {
        val context = OutboundFailingContext()
        val revoked = result().copy(
            actions = RecommendationActions(
                navigate = false,
                call = false,
                copyAddress = false,
                share = false,
            ),
        )

        assertFalse(AndroidRestaurantActions.openNavigation(context, revoked))
        assertFalse(AndroidRestaurantActions.dial(context, revoked))
        assertFalse(AndroidRestaurantActions.copyAddress(context, revoked))
        assertFalse(AndroidRestaurantActions.shareText(context, revoked.toRestaurantDisplayModel()))
        assertEquals(RestaurantShareOutcome.NOT_ALLOWED, AndroidRestaurantActions.share(context, revoked))
        assertEquals(0, context.outboundAccesses)
    }

    @Test
    fun `hard gate blocks generator before session cache or outbound access`() = runTest {
        val context = OutboundFailingContext()
        var sessionChecks = 0
        var generatorInvoked = false

        val outcome = AndroidRestaurantActions.shareWithGenerator(
            context = context,
            result = result(),
            sessionState = {
                sessionChecks += 1
                ResultSessionState.CURRENT
            },
            ioDispatcher = Dispatchers.Default,
        ) { _, _ ->
            generatorInvoked = true
            error("Android 1.0 must not invoke the share-card generator")
        }

        assertEquals(RestaurantShareOutcome.NOT_ALLOWED, outcome)
        assertEquals(0, sessionChecks)
        assertFalse(generatorInvoked)
        assertEquals(0, context.outboundAccesses)
    }

    @Test
    fun `hard gate does not consult a failing session or invoke the generator`() = runTest {
        val context = OutboundFailingContext()
        var generatorInvoked = false

        val outcome = AndroidRestaurantActions.shareWithGenerator(
            context = context,
            result = result(),
            sessionState = { error("Android 1.0 must return before session validation") },
            ioDispatcher = Dispatchers.Default,
        ) { _, _ ->
            generatorInvoked = true
            error("Android 1.0 must not invoke the share-card generator")
        }

        assertEquals(RestaurantShareOutcome.NOT_ALLOWED, outcome)
        assertFalse(generatorInvoked)
        assertEquals(0, context.outboundAccesses)
    }

    @Test
    fun `text share gate returns before session and every Android surface`() {
        val context = OutboundFailingContext()
        var sessionChecks = 0

        assertFalse(
            AndroidRestaurantActions.shareText(context, result().toRestaurantDisplayModel()) {
                sessionChecks += 1
                ResultSessionState.CURRENT
            },
        )
        assertEquals(0, sessionChecks)
        assertEquals(0, context.outboundAccesses)
    }

    private fun result() = RecommendationResult(
        provider = "AUTHORIZED_VENDOR",
        resultToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        dataMode = RecommendationDataMode.LIVE,
        actions = RecommendationActions(true, true, true, true),
        name = "测试餐厅",
        address = "北京市测试路 1 号",
        rank = 1,
        fitScore = null,
        sourceRating = 4.5,
        averageCostYuan = 35.0,
        distanceMeters = 420.0,
        estimatedTravelMinutes = 8.0,
        estimatedMealMinutes = 35.0,
        openStatus = OpenStatus.OPEN,
        tags = listOf("中餐"),
        imageUrl = null,
        phone = "+86 10 1234 5678",
        location = Coordinate(39.9, 116.4, crs = CoordinateReferenceSystem.GCJ02),
        reasons = emptyList(),
        warnings = emptyList(),
        confidence = Confidence.HIGH,
        aiAssisted = false,
        sourceAttribution = "授权数据源",
    )
}

/** Any Android surface access is a failure; revoked actions must return first. */
private class OutboundFailingContext : ContextWrapper(null) {
    var outboundAccesses = 0
        private set

    override fun startActivity(intent: Intent) {
        outboundAccesses += 1
        error("revoked action attempted to launch an Intent")
    }

    override fun getSystemService(name: String): Any? {
        outboundAccesses += 1
        error("revoked action attempted to access the clipboard")
    }

    override fun getCacheDir(): File {
        outboundAccesses += 1
        error("revoked action attempted to generate a share card")
    }

    override fun getPackageName(): String {
        outboundAccesses += 1
        error("revoked action attempted to build a FileProvider URI")
    }
}
