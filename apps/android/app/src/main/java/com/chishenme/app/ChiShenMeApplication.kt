package com.chishenme.app

import android.app.Application
import android.app.Activity
import android.os.Bundle
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
    private val maintenanceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val foregroundCleanupGate = ForegroundShareCardCleanupGate()

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                if (foregroundCleanupGate.onActivityStarted()) scheduleShareCardCleanup()
            }

            override fun onActivityStopped(activity: Activity) {
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
        maintenanceScope.cancel()
        super.onTerminate()
    }

    private fun scheduleShareCardCleanup() {
        maintenanceScope.launch {
            AndroidRestaurantActions.cleanupResidualShareCards(this@ChiShenMeApplication)
        }
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
