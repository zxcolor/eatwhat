package com.chishenme.app.feature.nearby

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.NearbyRestaurantsRepository
import com.chishenme.app.data.local.NearbyRestaurantCache
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import com.chishenme.app.location.ForegroundLocationClient
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.launch

@HiltViewModel
class NearbyCollectionViewModel @Inject constructor(
    locationClient: ForegroundLocationClient,
    repository: NearbyRestaurantsRepository,
    privacy: PrivacyAuthorizationGate,
    private val cache: NearbyRestaurantCache,
) : ViewModel() {
    private val controller = NearbyCollectionController(
        viewModelScope, locationClient, privacy::isAccepted,
        { choice, started, progress -> repository.collect(choice.coordinate, started, progress) },
    )
    val state = controller.state
    fun open(launchTimestamp: Long) {
        controller.open(launchTimestamp)
        viewModelScope.launch { runCatching { cache.prune() } }
    }
    fun configure(enabled: Boolean, permission: Boolean) = controller.configure(enabled, permission)
    fun permissionResult(granted: Boolean, permanent: Boolean) = controller.permissionResult(granted, permanent)
    fun retry(permission: Boolean) = controller.retry(permission)
    fun stop() = controller.stop()
    fun clearStatus() = controller.clearStatus()
    fun dismissReminder() = controller.dismissReminder()
}
