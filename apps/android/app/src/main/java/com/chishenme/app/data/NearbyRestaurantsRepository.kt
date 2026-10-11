package com.chishenme.app.data

import com.chishenme.app.data.local.NearbyRestaurantCache
import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.domain.CoordinateCrsTransform
import com.chishenme.app.data.remote.NearbyRestaurantRequest
import com.chishenme.app.data.remote.NearbyRestaurantCoordinate
import com.chishenme.app.data.remote.NearbyRestaurantResponse
import com.chishenme.app.data.remote.NearbyRestaurantsApi
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.*
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

@Singleton
class NearbyRestaurantsRepository @Inject constructor(
    private val api: NearbyRestaurantsApi,
    private val cache: NearbyRestaurantCache,
    private val privacy: PrivacyAuthorizationGate,
) {
    suspend fun collect(origin: Coordinate, startedAtMillis: Long, onProgress: (Int) -> Unit): Boolean {
        check(privacy.isAccepted())
        val session = cache.create(startedAtMillis, origin)
        var complete = false
        var limited = false
        try {
            var page = 1
            while (true) {
                currentCoroutineContext().ensureActive()
                check(privacy.isAccepted())
                val response = api.collect(NearbyRestaurantRequest(
                    NearbyRestaurantCoordinate(origin.latitude, origin.longitude, origin.crs), page,
                ))
                require(validNearbyPage(response, page)) { "Invalid nearby response" }
                require(response.restaurants.all {
                    withinNearbyRadius(origin, Coordinate(it.location.latitude, it.location.longitude, crs = it.location.crs))
                })
                currentCoroutineContext().ensureActive()
                check(privacy.isAccepted())
                onProgress(cache.append(session, response.restaurants, page))
                val next = response.nextPage
                if (next == null) {
                    complete = true
                    limited = response.truncated
                    return limited
                }
                page = next
            }
        } finally {
            // Atomic per-page files survive interruptions as an explicit partial
            // snapshot. Withdrawal may already have deleted this session.
            withContext(NonCancellable) { runCatching { cache.finish(session, complete, limited) } }
        }
    }
}

internal fun validNearbyPage(response: NearbyRestaurantResponse, page: Int): Boolean =
    response.radiusMeters == 3500 && response.retentionDays == 90 && response.page == page &&
        page in 1..2 && response.restaurants.size <= 25 &&
        (response.nextPage == null || response.nextPage == 2 && page == 1) &&
        (!response.truncated || page == 2 && response.nextPage == null) &&
        response.restaurants.all { place ->
            place.provider.matches(Regex("[A-Z][A-Z0-9_]{1,31}")) &&
                place.providerPlaceId.isNotBlank() && place.providerPlaceId.length <= 160 &&
                place.name.isNotBlank() && place.name.length <= 160 && place.address.length <= 240 &&
                place.location.latitude.isFinite() && place.location.latitude in -90.0..90.0 &&
                place.location.longitude.isFinite() && place.location.longitude in -180.0..180.0 &&
                (place.sourceRating == null || place.sourceRating.isFinite() && place.sourceRating in 0.0..5.0) &&
                (place.averageCostYuan == null || place.averageCostYuan.isFinite() && place.averageCostYuan in 0.0..20_000.0) &&
                place.tags.size <= 20 && place.tags.all { it.isNotBlank() && it.length <= 80 } &&
                (place.phone == null || place.phone.length <= 160) &&
                place.sourceAttribution.isNotBlank() && place.sourceAttribution.length <= 80
        }

internal fun withinNearbyRadius(origin: Coordinate, place: Coordinate): Boolean {
    val aligned = CoordinateCrsTransform.alignTo(origin.latitude, origin.longitude, origin.crs, place.crs) ?: return false
    val lat1 = Math.toRadians(aligned.latitude)
    val lat2 = Math.toRadians(place.latitude)
    val dLat = lat2 - lat1
    val dLon = Math.toRadians(place.longitude - aligned.longitude)
    val a = sin(dLat / 2).pow(2) + cos(lat1) * cos(lat2) * sin(dLon / 2).pow(2)
    val distance = 6_371_000 * 2 * atan2(sqrt(a.coerceIn(0.0, 1.0)), sqrt((1 - a).coerceIn(0.0, 1.0)))
    return distance.isFinite() && distance <= 3500
}
