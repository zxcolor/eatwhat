package com.chishenme.app

import android.app.Application
import android.app.Activity
import android.os.Bundle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.chishenme.app.auth.fusion.FusionAuthManager
import com.chishenme.app.feature.detail.AndroidRestaurantActions
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@HiltAndroidApp
class ChiShenMeApplication : Application() {
    @Inject lateinit var fusionAuth: FusionAuthManager

    private val maintenanceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val foregroundCleanupGate = ForegroundShareCardCleanupGate()
    private val fusionVisibilityGate = FusionActivityVisibilityGate()
    private lateinit var fusionProcessLifecycleObserver: FusionProcessLifecycleObserver

    override fun onCreate() {
        super.onCreate()
        // MainActivity legitimately stops while the vendor-owned Fusion Activity
        // is in front. ProcessLifecycleOwner stays STARTED for that hand-off, but
        // emits ON_STOP when the user backgrounds the whole app from the vendor
        // screen, so the in-memory token/proof and SDK scene are then revoked.
        fusionProcessLifecycleObserver =
            FusionProcessLifecycleObserver(fusionAuth::cancelForBackground)
        ProcessLifecycleOwner.get().lifecycle.addObserver(fusionProcessLifecycleObserver)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                fusionVisibilityGate.onActivityStarted()
                if (foregroundCleanupGate.onActivityStarted()) scheduleShareCardCleanup()
            }

            override fun onActivityStopped(activity: Activity) {
                if (fusionVisibilityGate.onActivityStopped(activity.isChangingConfigurations)) {
                    fusionAuth.cancelForBackground()
                }
                foregroundCleanupGate.onActivityStopped(activity.isChangingConfigurations)
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        // Cold-start cleanup is asynchronous; the first Activity start is not
        // counted again, while a later real background-to-foreground transition is.
        scheduleShareCardCleanup()
    }

    override fun onTerminate() {
        if (::fusionProcessLifecycleObserver.isInitialized) {
            ProcessLifecycleOwner.get().lifecycle.removeObserver(fusionProcessLifecycleObserver)
        }
        maintenanceScope.cancel()
        super.onTerminate()
    }

    private fun scheduleShareCardCleanup() {
        maintenanceScope.launch {
            AndroidRestaurantActions.cleanupResidualShareCards(this@ChiShenMeApplication)
        }
    }
}

internal class FusionProcessLifecycleObserver(
    private val cancelFusion: () -> Unit,
) : LifecycleEventObserver {
    override fun onStateChanged(source: LifecycleOwner, event: Lifecycle.Event) {
        if (event == Lifecycle.Event.ON_STOP) cancelFusion()
    }
}

/**
 * Immediate same-process visibility gate. Vendor-owned Fusion activities are
 * counted too, so MainActivity -> vendor UI is not mistaken for background,
 * while pressing Home from the vendor UI revokes the scene without waiting for
 * ProcessLifecycleOwner's delayed ON_STOP dispatch.
 */
internal class FusionActivityVisibilityGate {
    private var startedActivities = 0

    fun onActivityStarted() {
        startedActivities += 1
    }

    fun onActivityStopped(isChangingConfigurations: Boolean): Boolean {
        if (startedActivities > 0) startedActivities -= 1
        return startedActivities == 0 && !isChangingConfigurations
    }
}

/** Main-thread activity-count gate with configuration-change suppression. */
internal class ForegroundShareCardCleanupGate {
    private var startedActivities = 0
    private var hasEnteredForeground = false
    private var configurationChangeInProgress = false

    fun onActivityStarted(): Boolean {
        val enteringForeground = startedActivities == 0
        startedActivities += 1
        if (!enteringForeground) return false

        val shouldCleanup = hasEnteredForeground && !configurationChangeInProgress
        hasEnteredForeground = true
        configurationChangeInProgress = false
        return shouldCleanup
    }

    fun onActivityStopped(isChangingConfigurations: Boolean) {
        if (startedActivities > 0) startedActivities -= 1
        if (startedActivities == 0 && isChangingConfigurations) {
            configurationChangeInProgress = true
        }
    }
}
