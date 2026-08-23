package com.chishenme.app.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

@Singleton
class AndroidForegroundLocationClient @Inject constructor(
    @ApplicationContext private val context: Context,
) : ForegroundLocationClient {
    // The framework location service is not touched until currentLocation(), which is only
    // reachable after privacy consent and an explicit tap on "自动定位".
    private val locationManager: LocationManager by lazy {
        context.getSystemService(LocationManager::class.java)
    }

    @SuppressLint("MissingPermission")
    override suspend fun currentLocation(): ForegroundLocationResult {
        val coarseGranted = context.hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        val fineGranted = context.hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        if (!coarseGranted) {
            return ForegroundLocationResult.Failure(LocationFailure.PERMISSION_DENIED)
        }

        val access = if (fineGranted) LocationAccess.PRECISE else LocationAccess.APPROXIMATE
        val manager = locationManager
        if (!LocationManagerCompat.isLocationEnabled(manager)) {
            return ForegroundLocationResult.Failure(LocationFailure.PROVIDER_DISABLED)
        }

        val providers = enabledProviders(manager, access)
        if (providers.isEmpty()) {
            return ForegroundLocationResult.Failure(LocationFailure.PROVIDER_DISABLED)
        }

        return try {
            var anyAttemptTimedOut = false
            for (provider in providers) {
                val attempt = withTimeoutOrNull(PER_PROVIDER_TIMEOUT_MILLIS) {
                    ProviderAttempt(awaitCurrentLocation(manager, provider))
                }
                if (attempt == null) {
                    anyAttemptTimedOut = true
                    continue
                }
                val fix = attempt.location?.toFix()
                if (fix != null) {
                    return ForegroundLocationResult.Success(fix = fix, access = access)
                }
            }
            ForegroundLocationResult.Failure(
                if (anyAttemptTimedOut) LocationFailure.TIMEOUT else LocationFailure.UNAVAILABLE,
            )
        } catch (cancelled: CancellationException) {
            // Manual selection and privacy withdrawal cancel the in-flight request. Never
            // turn that cancellation into a late error state that could overwrite the UI.
            throw cancelled
        } catch (_: SecurityException) {
            ForegroundLocationResult.Failure(LocationFailure.PERMISSION_DENIED)
        } catch (_: RuntimeException) {
            ForegroundLocationResult.Failure(LocationFailure.UNAVAILABLE)
        }
    }

    private fun enabledProviders(
        manager: LocationManager,
        access: LocationAccess,
    ): List<String> {
        val preferred = if (access == LocationAccess.PRECISE) {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        } else {
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        }
        val available = manager.allProviders.toSet()
        return preferred.filter { provider ->
            provider in available && runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false)
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun awaitCurrentLocation(
        manager: LocationManager,
        provider: String,
    ): Location? = suspendCancellableCoroutine { continuation ->
        val cancellationSignal = CancellationSignal()
        continuation.invokeOnCancellation { cancellationSignal.cancel() }
        LocationManagerCompat.getCurrentLocation(
            manager,
            provider,
            cancellationSignal,
            ContextCompat.getMainExecutor(context),
        ) { location ->
            if (continuation.isActive) continuation.resume(location)
        }
    }

    private fun Context.hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun Location.toFix(): LocationFix? {
        if (!latitude.isFinite() || latitude !in -90.0..90.0) return null
        if (!longitude.isFinite() || longitude !in -180.0..180.0) return null
        return LocationFix(
            latitude = latitude,
            longitude = longitude,
            accuracyMeters = accuracy.toDouble().takeIf {
                hasAccuracy() && it.isFinite() && it > 0.0 && it <= MAX_COORDINATE_ACCURACY_METERS
            },
            // Android framework Location is defined in the WGS84 datum.
            crs = CoordinateReferenceSystem.WGS84,
        )
    }

    private data class ProviderAttempt(val location: Location?)

    private companion object {
        const val PER_PROVIDER_TIMEOUT_MILLIS = 6_000L
        const val MAX_COORDINATE_ACCURACY_METERS = 10_000.0
    }
}
