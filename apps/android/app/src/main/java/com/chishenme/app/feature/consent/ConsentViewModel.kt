package com.chishenme.app.feature.consent

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chishenme.app.data.AuthRepository
import com.chishenme.app.data.local.AppPreferences
import com.chishenme.app.data.local.NearbyRestaurantCache
import com.chishenme.app.data.local.ThemePreference
import dagger.Lazy
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class ConsentViewModel @Inject constructor(
    private val preferences: AppPreferences,
    private val authRepository: Lazy<AuthRepository>,
    private val withdrawalMarker: PrivacyWithdrawalMarkerStore,
    private val privacyAuthorizationGate: PrivacyAuthorizationGate,
    private val nearbyCache: Lazy<NearbyRestaurantCache>,
) : ViewModel() {
    private val mutableWithdrawalPersistenceFailed = MutableStateFlow(false)

    private val privacyConsent = PrivacyConsentCoordinator(
        persistedConsent = preferences.privacyAccepted,
        persistConsent = { accepted ->
            preferences.setPrivacyAccepted(accepted)
            if (!accepted) nearbyCache.get().clear()
        },
        revokeAuthAttempts = {
            privacyAuthorizationGate.revoke()
            authRepository.get().revokeAuthAttemptsForPrivacyWithdrawal()
        },
        allowAuthAttempts = {
            if (!privacyAuthorizationGate.allowAfterDurableAcceptance()) {
                false
            } else {
                try {
                    authRepository.get().allowAuthAttemptsAfterPrivacyConsent()
                    true
                } catch (_: Exception) {
                    privacyAuthorizationGate.revoke()
                    false
                }
            }
        },
        clearLocalSession = {
            authRepository.get().clearLocalSession()
            if (withdrawalMarker.isBlocked()) nearbyCache.get().clear()
        },
        durableWithdrawalBlocked = withdrawalMarker::isBlocked,
        blockWithdrawalDurably = withdrawalMarker::block,
        clearDurableWithdrawalBlock = withdrawalMarker::clear,
        scope = viewModelScope,
    )

    val privacyAccepted: StateFlow<Boolean?> = privacyConsent.privacyAccepted
    init {
        // Finish a withdrawal interrupted by process death even while the
        // first-run screen is shown. This only deletes local files.
        viewModelScope.launch {
            privacyAccepted.collectLatest { accepted ->
                if (accepted == false) runCatching { nearbyCache.get().clear() }
            }
        }
    }
    private val acceptanceController = ConsentAcceptanceController(
        scope = viewModelScope,
        accept = privacyConsent::acceptPrivacy,
        onAccepted = { mutableWithdrawalPersistenceFailed.value = false },
    )
    val acceptanceState: StateFlow<ConsentAcceptanceState> = acceptanceController.state
    val withdrawalPersistenceFailed: StateFlow<Boolean> =
        mutableWithdrawalPersistenceFailed.asStateFlow()

    val themePreference: StateFlow<ThemePreference> = preferences.themePreference
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ThemePreference.SYSTEM)

    fun acceptPrivacy() {
        acceptanceController.submit()
    }

    fun withdrawPrivacy(cancelExternalAuthorization: () -> Unit) {
        // The UI gate closes synchronously, before any provider/backend callback
        // can regain commit authority or this method returns to the dialog.
        val operation = privacyConsent.beginWithdrawal(cancelExternalAuthorization)
        acceptanceController.resetForWithdrawal()
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            mutableWithdrawalPersistenceFailed.value =
                !privacyConsent.persistWithdrawalAndClear(operation)
        }
    }
}
