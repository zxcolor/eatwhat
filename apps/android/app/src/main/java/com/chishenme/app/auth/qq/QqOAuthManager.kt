package com.chishenme.app.auth.qq

import android.app.Activity
import android.content.Intent
import com.chishenme.app.data.remote.OAuthPurpose
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

internal fun interface QqConsentGate {
    suspend fun isAccepted(): Boolean
}

internal interface QqSdkSessionFactory {
    val isConfigured: Boolean
    fun create(onCallback: (QqSdkCallback) -> Unit): QqSdkSession
    fun revokePrivacyConsent()
}

internal interface QqSdkSession {
    fun launchLogin(activity: Activity): Boolean
    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean
    fun clear()
}

internal interface QqLoginHost {
    val isAvailable: Boolean
    fun launch(session: QqSdkSession): Boolean
}

internal fun Activity.toQqLoginHost(): QqLoginHost = object : QqLoginHost {
    override val isAvailable: Boolean
        get() = !isFinishing && !isDestroyed

    override fun launch(session: QqSdkSession): Boolean = session.launchLogin(this@toQqLoginHost)
}

internal sealed interface QqSdkCallback {
    class Authorized(val authorizationCode: String?) : QqSdkCallback {
        override fun toString(): String = "QqSdkCallback.Authorized"
    }

    data object Cancelled : QqSdkCallback
    data object Denied : QqSdkCallback
    data object Error : QqSdkCallback
    data object Invalid : QqSdkCallback
}

internal sealed interface QqOAuthStartResult {
    data object Started : QqOAuthStartResult
    data class Failed(val reason: QqOAuthFailure) : QqOAuthStartResult
}

internal sealed interface QqOAuthEvent {
    /**
     * The proof can be taken once by the account ViewModel and is never exposed
     * through UI state. Debug text deliberately contains neither state nor code.
     */
    class Authorized internal constructor(
        val purpose: OAuthPurpose,
        state: String,
        authorizationCode: String,
    ) : QqOAuthEvent {
        private val proof = AtomicReference(Proof(state, authorizationCode))

        internal suspend fun <Value> consumeProof(
            block: suspend (state: String, authorizationCode: String) -> Value,
        ): Value? {
            val current = proof.getAndSet(null) ?: return null
            return block(current.state, current.authorizationCode)
        }

        internal fun discardProof() {
            proof.set(null)
        }

        override fun toString(): String = "QqOAuthEvent.Authorized(purpose=$purpose)"

        private class Proof(
            val state: String,
            val authorizationCode: String,
        ) {
            override fun toString(): String = "QqOAuthProof(redacted)"
        }
    }

    /** Provider error objects and text are never copied into this event. */
    data class Failed(
        val purpose: OAuthPurpose?,
        val reason: QqOAuthFailure,
    ) : QqOAuthEvent
}

/**
 * Owns one explicit, consented QQ login/bind attempt. Constructing or injecting
 * this manager does not initialize Tencent OpenSDK.
 */
@Singleton
class QqOAuthManager internal constructor(
    private val consentGate: QqConsentGate,
    private val sessionFactory: QqSdkSessionFactory,
    private val coordinator: QqOAuthCoordinator,
) {
    @Inject
    internal constructor(
        consentGate: AppQqConsentGate,
        sessionFactory: AndroidQqSdkSessionFactory,
    ) : this(consentGate, sessionFactory, QqOAuthCoordinator())

    private val lock = Any()
    private var activeAttempt: ActiveAttempt? = null
    private var privacyGeneration = 0L
    private var privacyBlocked = false
    private val mutableEvents = MutableSharedFlow<QqOAuthEvent>(extraBufferCapacity = 1)

    internal val events: SharedFlow<QqOAuthEvent> = mutableEvents.asSharedFlow()
    val clientConfigured: Boolean
        get() = sessionFactory.isConfigured

    internal suspend fun beginAuthorization(
        host: QqLoginHost,
        purpose: OAuthPurpose,
        state: String,
        expiresAt: Instant,
    ): QqOAuthStartResult {
        val expectedPrivacyGeneration = synchronized(lock) {
            if (privacyBlocked) null else privacyGeneration
        } ?: return QqOAuthStartResult.Failed(QqOAuthFailure.PRIVACY_REQUIRED)
        val accepted = try {
            consentGate.isAccepted()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }
        if (!accepted) return QqOAuthStartResult.Failed(QqOAuthFailure.PRIVACY_REQUIRED)
        if (!sessionFactory.isConfigured) {
            return QqOAuthStartResult.Failed(QqOAuthFailure.CLIENT_NOT_CONFIGURED)
        }
        if (!host.isAvailable) {
            return QqOAuthStartResult.Failed(QqOAuthFailure.HOST_ACTIVITY_UNAVAILABLE)
        }
        val marker = Any()
        return synchronized(lock) {
            if (privacyBlocked || privacyGeneration != expectedPrivacyGeneration) {
                return@synchronized QqOAuthStartResult.Failed(
                    QqOAuthFailure.PRIVACY_REQUIRED,
                )
            }
            if (activeAttempt != null) {
                return@synchronized QqOAuthStartResult.Failed(QqOAuthFailure.BUSY)
            }
            when (val prepared = coordinator.prepare(purpose, state, expiresAt)) {
                is QqCoordinatorPrepareResult.Rejected -> {
                    return@synchronized QqOAuthStartResult.Failed(prepared.failure)
                }
                QqCoordinatorPrepareResult.Ready -> Unit
            }
            val attempt = ActiveAttempt(marker)
            activeAttempt = attempt
            val session = try {
                // Factory creation is the first point allowed to notify or create
                // Tencent OpenSDK, after both consent and explicit user action.
                sessionFactory.create { callback -> acceptSdkCallback(marker, callback) }
            } catch (_: Exception) {
                coordinator.cancel()
                activeAttempt = null
                runCatching { sessionFactory.revokePrivacyConsent() }
                return@synchronized QqOAuthStartResult.Failed(
                    QqOAuthFailure.SDK_INITIALIZATION_FAILED,
                )
            }
            attempt.session = session
            val launched = try {
                host.launch(session)
            } catch (_: Exception) {
                false
            }
            if (!launched) {
                coordinator.cancel()
                activeAttempt = null
                safeClear(session)
                return@synchronized QqOAuthStartResult.Failed(
                    QqOAuthFailure.AUTHORIZATION_LAUNCH_FAILED,
                )
            }
            QqOAuthStartResult.Started
        }
    }

    /** Called only from MainActivity's real onActivityResult callback. */
    internal fun handleActivityResult(
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
    ): Boolean {
        val session = synchronized(lock) { activeAttempt?.session } ?: return false
        val handled = try {
            session.handleActivityResult(requestCode, resultCode, data)
        } catch (_: Exception) {
            false
        }
        // False can simply mean another Activity result while QQ is pending.
        // The Android adapter converts a matching-but-invalid QQ result into an
        // explicit Invalid callback, so unrelated results must not cancel it.
        return handled
    }

    /** Test seam for a callback belonging to the currently active SDK session. */
    internal fun acceptSdkCallback(callback: QqSdkCallback) {
        val marker = synchronized(lock) { activeAttempt?.marker } ?: return
        acceptSdkCallback(marker, callback)
    }

    internal fun cancelAuthorization() {
        cancelAttempt()
    }

    /** Withdrawal clears state/session, revokes the SDK flag, and fails closed. */
    fun revokePrivacyConsent() {
        val cancelled = synchronized(lock) {
            privacyBlocked = true
            privacyGeneration += 1
            cancelAttemptLocked()
        }
        cancelled?.session?.let(::safeClear)
        runCatching { sessionFactory.revokePrivacyConsent() }
        mutableEvents.tryEmit(
            QqOAuthEvent.Failed(
                purpose = cancelled?.purpose,
                reason = QqOAuthFailure.PRIVACY_REQUIRED,
            ),
        )
    }

    /** Reopens only attempts started after accepted consent has been persisted. */
    fun allowPrivacyConsent() {
        synchronized(lock) {
            if (privacyBlocked) {
                privacyBlocked = false
                privacyGeneration += 1
            }
        }
    }

    private fun acceptSdkCallback(marker: Any, callback: QqSdkCallback) {
        val resolution = synchronized(lock) {
            val attempt = activeAttempt
                ?.takeIf { it.marker === marker && it.session != null }
                ?: return
            val event = when (callback) {
                is QqSdkCallback.Authorized -> when (
                    val consumed = coordinator.consume(callback.authorizationCode)
                ) {
                    is QqCoordinatorConsumeResult.Accepted -> QqOAuthEvent.Authorized(
                        purpose = consumed.purpose,
                        state = consumed.state,
                        authorizationCode = consumed.authorizationCode,
                    )
                    is QqCoordinatorConsumeResult.Rejected -> QqOAuthEvent.Failed(
                        purpose = consumed.purpose,
                        reason = consumed.failure,
                    )
                }
                QqSdkCallback.Cancelled -> QqOAuthEvent.Failed(
                    purpose = coordinator.cancel(),
                    reason = QqOAuthFailure.USER_CANCELLED,
                )
                QqSdkCallback.Denied -> QqOAuthEvent.Failed(
                    purpose = coordinator.cancel(),
                    reason = QqOAuthFailure.AUTHORIZATION_DENIED,
                )
                QqSdkCallback.Error -> QqOAuthEvent.Failed(
                    purpose = coordinator.cancel(),
                    reason = QqOAuthFailure.SDK_ERROR,
                )
                QqSdkCallback.Invalid -> QqOAuthEvent.Failed(
                    purpose = coordinator.cancel(),
                    reason = QqOAuthFailure.INVALID_CALLBACK,
                )
            }
            activeAttempt = null
            CallbackResolution(checkNotNull(attempt.session), event)
        }
        // Clear Tencent's session cache before handing the short-lived proof to
        // the backend orchestration layer.
        safeClear(resolution.session)
        mutableEvents.tryEmit(resolution.event)
    }

    private fun cancelAttempt(expectedMarker: Any? = null): CancelledAttempt? {
        val cancelled = synchronized(lock) {
            cancelAttemptLocked(expectedMarker)
        }
        cancelled?.session?.let(::safeClear)
        return cancelled
    }

    private fun cancelAttemptLocked(expectedMarker: Any? = null): CancelledAttempt? {
        val attempt = activeAttempt
        if (expectedMarker != null && attempt?.marker !== expectedMarker) return null
        val purpose = coordinator.cancel()
        activeAttempt = null
        return CancelledAttempt(purpose, attempt?.session)
    }

    private fun safeClear(session: QqSdkSession) {
        runCatching { session.clear() }
    }

    private class ActiveAttempt(
        val marker: Any,
        var session: QqSdkSession? = null,
    )

    private data class CancelledAttempt(
        val purpose: OAuthPurpose?,
        val session: QqSdkSession?,
    )

    private data class CallbackResolution(
        val session: QqSdkSession,
        val event: QqOAuthEvent,
    )
}
