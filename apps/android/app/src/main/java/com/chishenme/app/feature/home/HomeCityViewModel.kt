package com.chishenme.app.feature.home

import androidx.lifecycle.ViewModel
import com.chishenme.app.data.remote.LocationCityApi
import com.chishenme.app.data.remote.LocationCityCoordinate
import com.chishenme.app.data.remote.LocationCityRequest
import com.chishenme.app.domain.LocationChoice
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** City resolution is kept in the authorized Activity session, never on disk. */
@HiltViewModel
class HomeCityViewModel @Inject constructor(private val api: LocationCityApi) : ViewModel() {
    private val mutex = Mutex()
    private var resolved: Pair<LocationCityCoordinate, String?>? = null
    private var generation = 0L

    suspend fun resolve(location: LocationChoice): String? = mutex.withLock {
        val coordinate = location.coordinate.let { LocationCityCoordinate(it.latitude, it.longitude, it.crs) }
        resolved?.takeIf { it.first == coordinate }?.let { return@withLock it.second }
        val startedGeneration = generation
        val city = api.city(LocationCityRequest(coordinate)).city
            ?.trim()?.takeIf { it.isNotEmpty() && it.length <= 80 }
        if (startedGeneration != generation) return@withLock null
        resolved = coordinate to city
        city
    }

    fun clear() { generation++; resolved = null }
}
