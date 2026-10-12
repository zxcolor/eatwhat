package com.chishenme.app.feature.nearby

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.chishenme.app.domain.LocationChoice
import com.chishenme.app.location.LocationFailure
import com.chishenme.app.location.LocationSettingsTarget
import com.chishenme.app.location.presentation

@Composable
fun StartupNearbyCollection(
    viewModel: NearbyCollectionViewModel,
    enabled: Boolean,
    launchTimestamp: Long,
    onLocationFound: (LocationChoice) -> Unit,
) {
    val context = LocalContext.current
    val activity = context.nearbyActivity()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state by viewModel.state.collectAsStateWithLifecycle()
    val currentEnabled by rememberUpdatedState(enabled)
    val currentLocationFound by rememberUpdatedState(onLocationFound)
    var rationale by remember { mutableStateOf(false) }
    fun granted() = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    fun needsRationale() = activity?.let {
        ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.ACCESS_COARSE_LOCATION)
    } ?: false
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        rationale = false
        viewModel.permissionResult(granted(), result.isNotEmpty() && !granted() && !needsRationale())
    }
    fun request() = permission.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))

    DisposableEffect(lifecycle, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    viewModel.open(launchTimestamp)
                    viewModel.configure(currentEnabled, granted())
                }
                Lifecycle.Event.ON_STOP -> if (activity?.isChangingConfigurations != true) viewModel.stop()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            if (activity?.isChangingConfigurations != true) viewModel.stop()
        }
    }
    LaunchedEffect(enabled) {
        if (!enabled) rationale = false
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) viewModel.configure(enabled, granted())
    }
    LaunchedEffect(state.phase) {
        if (state.phase == NearbyPhase.PERMISSION && enabled && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            if (needsRationale()) rationale = true else request()
        }
    }
    LaunchedEffect(state.location) { state.location?.let(currentLocationFound) }

    if (rationale) AlertDialog(
        onDismissRequest = { rationale = false; viewModel.dismissReminder() },
        title = { Text("允许定位以收集附近餐厅") },
        text = { Text("打开应用时获取当前位置，查询 3.5 km 内最多两页餐厅，与本次用户位置和定位精度一起，按启动时间保存到本机，保留 90 天。拒绝后仍可手动选地点。") },
        confirmButton = { TextButton(onClick = { rationale = false; request() }) { Text("允许定位") } },
        dismissButton = { TextButton(onClick = { rationale = false; viewModel.dismissReminder() }) { Text("暂不开启") } },
    )
    if (state.phase == NearbyPhase.FAILED) {
        val presentation = state.failure?.presentation()
        val exhausted = state.attempt == 6
        AlertDialog(
            onDismissRequest = viewModel::dismissReminder,
            title = { Text(if (state.failure != null) "定位提醒" else "餐厅收集提醒") },
            text = { Text((if (exhausted) "首次定位及 5 次重试均未成功。\n" else "") +
                (state.message ?: presentation?.message.orEmpty())) },
            confirmButton = {
                val target = presentation?.settingsTarget ?: LocationSettingsTarget.NONE
                TextButton(onClick = {
                    viewModel.dismissReminder()
                    when (target) {
                        LocationSettingsTarget.APP -> context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${context.packageName}".toUri()))
                        LocationSettingsTarget.DEVICE_LOCATION -> context.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                        LocationSettingsTarget.NONE -> viewModel.retry(granted())
                    }
                }) { Text(if (target == LocationSettingsTarget.NONE) "重新尝试" else "前往设置") }
            },
            dismissButton = { TextButton(onClick = viewModel::dismissReminder) { Text("稍后再说") } },
        )
    }
}

private fun Context.nearbyActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.nearbyActivity()
    else -> null
}
