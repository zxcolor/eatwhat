package com.chishenme.app.feature.home

import android.location.Address
import android.location.Geocoder
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.platform.LocalContext
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.domain.LocationChoice
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Resolve the city of an already authorized foreground fix; never replace its coordinates. */
@Composable
internal fun resolvedHomeLocationLabel(
    location: LocationChoice?,
    remoteEnabled: Boolean,
    resolveCity: suspend (LocationChoice) -> String?,
): String? {
    val context = LocalContext.current
    val fallback = if (location != null) "城市暂未获取" else null
    val label by produceState(fallback, location, remoteEnabled) {
        value = fallback
        if (location != null && remoteEnabled) {
            val city = withTimeoutOrNull(4_000) {
                try { resolveCity(location) }
                catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                catch (_: Exception) { null }
            }
            if (!city.isNullOrBlank()) {
                value = city
                return@produceState
            }
        }
        // System Geocoder expects WGS84. A manual provider selection may carry GCJ-02;
        // do not misinterpret it or fall back to its street/name as a city.
        if (location == null || location.coordinate.crs != CoordinateReferenceSystem.WGS84 ||
            !Geocoder.isPresent()
        ) return@produceState
        val address = withTimeoutOrNull(4_000) {
            try {
                val geocoder = Geocoder(context, Locale.SIMPLIFIED_CHINESE)
                if (Build.VERSION.SDK_INT >= 33) {
                    suspendCancellableCoroutine<Address?> { continuation ->
                        geocoder.getFromLocation(location.coordinate.latitude, location.coordinate.longitude, 1,
                            object : Geocoder.GeocodeListener {
                                override fun onGeocode(addresses: MutableList<Address>) {
                                    if (continuation.isActive) continuation.resume(addresses.firstOrNull())
                                }
                                override fun onError(errorMessage: String?) {
                                    if (continuation.isActive) continuation.resume(null)
                                }
                            })
                    }
                } else {
                    withContext(Dispatchers.IO) {
                        @Suppress("DEPRECATION")
                        geocoder.getFromLocation(location.coordinate.latitude, location.coordinate.longitude, 1)?.firstOrNull()
                    }
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (_: Exception) { null }
        }
        address?.let {
            homeCityName(it.locality, it.adminArea)?.let { city -> value = city }
        }
    }
    return label
}

/** A municipality may be reported as adminArea with a district in locality. */
internal fun homeCityName(locality: String?, adminArea: String?): String? {
    val administration = adminArea?.trim()?.takeIf(String::isNotEmpty)
    val municipality = administration?.takeIf {
        it.removeSuffix("市") in setOf("北京", "上海", "天津", "重庆")
    }
    return municipality ?: locality?.trim()?.takeIf(String::isNotEmpty)
}
