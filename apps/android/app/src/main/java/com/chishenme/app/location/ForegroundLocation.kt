package com.chishenme.app.location

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.domain.LocationChoice

enum class LocationAccess {
    APPROXIMATE,
    PRECISE,
}

data class LocationFix(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double?,
    val crs: CoordinateReferenceSystem,
)

sealed interface ForegroundLocationResult {
    data class Success(
        val fix: LocationFix,
        val access: LocationAccess,
    ) : ForegroundLocationResult

    data class Failure(val reason: LocationFailure) : ForegroundLocationResult
}

enum class LocationFailure {
    PERMISSION_DENIED,
    PERMISSION_PERMANENTLY_DENIED,
    PROVIDER_DISABLED,
    TIMEOUT,
    UNAVAILABLE,
}

enum class LocationSettingsTarget {
    NONE,
    APP,
    DEVICE_LOCATION,
}

data class LocationFailurePresentation(
    val message: String,
    val settingsTarget: LocationSettingsTarget,
)

sealed interface LocationUiState {
    data object Idle : LocationUiState
    data object AwaitingPermission : LocationUiState
    data object Locating : LocationUiState
    data class Ready(
        val access: LocationAccess,
        val accuracyMeters: Double?,
    ) : LocationUiState
    data class Failed(val reason: LocationFailure) : LocationUiState
}

interface ForegroundLocationClient {
    /** Called only in foreground, after privacy consent and runtime permission handling. */
    suspend fun currentLocation(): ForegroundLocationResult
}

object ForegroundLocationMapper {
    fun toLocationChoice(fix: LocationFix, access: LocationAccess): LocationChoice? {
        if (!fix.latitude.isFinite() || fix.latitude !in -90.0..90.0) return null
        if (!fix.longitude.isFinite() || fix.longitude !in -180.0..180.0) return null

        val accuracy = fix.accuracyMeters?.takeIf {
            it.isFinite() && it > 0.0 && it <= MAX_COORDINATE_ACCURACY_METERS
        }
        return LocationChoice(
            label = if (access == LocationAccess.APPROXIMATE) "我的大致位置" else "我的当前位置",
            coordinate = Coordinate(
                latitude = fix.latitude,
                longitude = fix.longitude,
                accuracyMeters = accuracy,
                crs = fix.crs,
            ),
            isDemonstration = false,
            isApproximate = access == LocationAccess.APPROXIMATE,
        )
    }
}

private const val MAX_COORDINATE_ACCURACY_METERS = 10_000.0

fun LocationFailure.presentation(): LocationFailurePresentation = when (this) {
    LocationFailure.PERMISSION_DENIED -> LocationFailurePresentation(
        message = "未获得位置权限。你仍可手动选择地点，或再次点击自动定位授权。",
        settingsTarget = LocationSettingsTarget.NONE,
    )
    LocationFailure.PERMISSION_PERMANENTLY_DENIED -> LocationFailurePresentation(
        message = "系统已停止询问位置权限。请在应用设置中允许位置权限，或继续手动选择地点。",
        settingsTarget = LocationSettingsTarget.APP,
    )
    LocationFailure.PROVIDER_DISABLED -> LocationFailurePresentation(
        message = "系统定位服务未开启。请打开设备定位后重试，或手动选择地点。",
        settingsTarget = LocationSettingsTarget.DEVICE_LOCATION,
    )
    LocationFailure.TIMEOUT -> LocationFailurePresentation(
        message = "暂时没有取得当前位置。请移到较开阔处后重试，或手动选择地点。",
        settingsTarget = LocationSettingsTarget.NONE,
    )
    LocationFailure.UNAVAILABLE -> LocationFailurePresentation(
        message = "当前设备暂时无法提供位置。请稍后重试，或手动选择地点。",
        settingsTarget = LocationSettingsTarget.NONE,
    )
}
