package com.chishenme.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.chishenme.app.BuildConfig
import com.chishenme.app.MainActivity
import com.chishenme.app.R

internal data class DecisionLauncherWidgetLaunchContract(
    val action: String,
    val targetActivityClassName: String,
    val activityFlags: Int,
    val pendingIntentFlags: Int,
    val requestCode: Int,
)

internal val decisionLauncherWidgetLaunchContract = DecisionLauncherWidgetLaunchContract(
    action = "${BuildConfig.APPLICATION_ID}.action.OPEN_HOME_FROM_WIDGET",
    targetActivityClassName = MainActivity::class.java.name,
    activityFlags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
    pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    requestCode = 11_001,
)

internal object DecisionLauncherWidgetPendingIntentFactory {
    fun create(context: Context): PendingIntent {
        val contract = decisionLauncherWidgetLaunchContract
        val intent = Intent(contract.action).apply {
            setClassName(context, contract.targetActivityClassName)
            flags = contract.activityFlags
        }
        return PendingIntent.getActivity(
            context,
            contract.requestCode,
            intent,
            contract.pendingIntentFlags,
        )
    }
}

class DecisionLauncherWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val views = RemoteViews(context.packageName, R.layout.widget_decision_launcher).apply {
            setOnClickPendingIntent(
                R.id.widget_decision_action,
                DecisionLauncherWidgetPendingIntentFactory.create(context),
            )
        }
        appWidgetIds.forEach { appWidgetId ->
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
