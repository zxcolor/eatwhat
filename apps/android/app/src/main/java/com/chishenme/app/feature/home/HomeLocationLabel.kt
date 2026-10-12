package com.chishenme.app.feature.home

import android.location.Address
import android.location.Geocoder
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.platform.LocalContext
import com.chishenme.app.domain.LocationChoice
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Resolve only an already authorized foreground fix; never replace its coordinates. */
@Composable
internal fun resolvedHomeLocationLabel(location: LocationChoice?): String? {
    val context = LocalContext.current
    val automatic = location?.label in setOf("我的当前位置", "我的大致位置")
    val fallback = if (automatic && location != null) {
        String.format(Locale.ROOT, "%.4f, %.4f", location.coordinate.latitude, location.coordinate.longitude)
    } else location?.label
    val label by produceState(fallback, location) {
        value = fallback
        if (!automatic || location == null || !Geocoder.isPresent()) return@produceState
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
            val name = listOf(it.locality, it.subLocality, it.thoroughfare, it.subThoroughfare)
                .filterNotNull().filter(String::isNotBlank).distinct().joinToString("")
                .ifBlank { it.getAddressLine(0).orEmpty() }
            if (name.isNotBlank()) value = if (location.isApproximate) "$name 附近" else name
        }
    }
    return label
}
