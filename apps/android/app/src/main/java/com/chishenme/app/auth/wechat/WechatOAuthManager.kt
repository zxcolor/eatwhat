package com.chishenme.app.auth.wechat

import android.content.Intent
import com.chishenme.app.data.remote.OAuthPurpose
import java.lang.ref.WeakReference
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

internal fun interface WechatConsentGate {
    suspend fun isAccepted(): Boolean
}

internal interface WechatSdkSessionFactory {
    val isConfigured: Boolean
    fun create(): WechatSdkSession
}

internal interface WechatSdkSession {
    fun registerApp(): Boolean
    fun isWechatInstalled(): Boolean
    fun sendAuthorization(state: String): Boolean
    fun handleIntent(intent: Intent, onCallback: (WechatSdkCallback) -> Unit): Boolean
    fun detach()
}

internal sealed interface WechatSdkCallback {
    class Authorized(
        val state: String?,
        val authorizationCode: String?,
    ) : WechatSdkCallback {
        override fun toString(): String = "WechatSdkCallback.Authorized"
    }
    data object Cancelled : WechatSdkCallback
    data object Denied : WechatSdkCallback
    data object Invalid : WechatSdkCallback
}

internal sealed interface WechatOAuthStartResult {
    data object Started : WechatOAuthStartResult
    data class Failed(val reason: WechatOAuthFailure) : WechatOAuthStartResult
}

internal sealed interface WechatOAuthEvent {
    class Authorized internal constructor(
        val purpose: OAuthPurpose,
        state: String,
        authorizationCode: String,
    ) : WechatOAuthEvent {
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

        override fun toString(): String = "WechatOAuthEvent.Authorized(purpose=$purpose)"

        private class Proof(
            val state: String,
            val authorizationCode: String,
        ) {
            override fun toString(): String = "WechatOAuthProof(redacted)"
        }
    }

    /** Failure intentionally carries no provider error, state, code, or text. */
    data class Failed(
        val purpose: OAuthPurpose?,
        val reason: WechatOAuthFailure,
    ) : WechatOAuthEvent
}

/**
 * Lazily launches the official WeChat SDK and owns one process-local attempt.
 * Injecting this object is safe: the SDK factory is not invoked until
 * [beginAuthorization] passes the privacy and configuration gates.
 */
@Singleton
class WechatOAuthManager internal constructor(
    private val consentGate: WechatConsentGate,
    private val sessionFactory: WechatSdkSessionFactory,
    private val coordinator: WechatOAuthCoordinator,
) {
    @Inject
    internal constructor(
        consentGate: AppWechatConsentGate,
        sessionFactory: AndroidWechatSdkSessionFactory,
    ) : this(consentGate, sessionFactory, WechatOAuthCoordinator())

    private val lock = Any()
    private var activeAttempt: ActiveAttempt? = null
    private var privacyGeneration = 0L
    private var privacyBlocked = false
    private val mutableEvents = MutableSharedFlow<WechatOAuthEvent>(extraBufferCapacity = 1)

    internal val events: SharedFlow<WechatOAuthEvent> = mutableEvents.asSharedFlow()
    val clientConfigured: Boolean
        get() = sessionFactory.isConfigured

    internal suspend fun beginAuthorization(
        purpose: OAuthPurpose,
        state: String,
        expiresAt: Instant,
    ): WechatOAuthStartResult {
        val expectedPrivacyGeneration = synchronized(lock) {
            if (privacyBlocked) null else privacyGeneration
        } ?: return WechatOAuthStartResult.Failed(WechatOAuthFailure.PRIVACY_REQUIRED)
        val accepted = try {
            consentGate.isAccepted()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }
        if (!accepted) {
            return WechatOAuthStartResult.Failed(WechatOAuthFailure.PRIVACY_REQUIRED)
        }
        if (!sessionFactory.isConfigured) {
            return WechatOAuthStartResult.Failed(WechatOAuthFailure.CLIENT_NOT_CONFIGURED)
        }
        val marker = Any()
        return synchronized(lock) {
            if (privacyBlocked || privacyGeneration != expectedPrivacyGeneration) {
                return@synchronized WechatOAuthStartResult.Failed(
                    WechatOAuthFailure.PRIVACY_REQUIRED,
                )
            }
            if (activeAttempt != null) {
                return@synchronized WechatOAuthStartResult.Failed(WechatOAuthFailure.BUSY)
            }
            when (val prepared = coordinator.prepare(purpose, state, expiresAt)) {
                is WechatCoordinatorPrepareResult.Rejected -> {
                    return@synchronized WechatOAuthStartResult.Failed(prepared.failure)
                }
                WechatCoordinatorPrepareResult.Ready -> Unit
            }
            val attempt = ActiveAttempt(marker)
            activeAttempt = attempt
            val session = runCatching { sessionFactory.create() }.getOrElse {
                coordinator.cancel()
                activeAttempt = null
                return@synchronized WechatOAuthStartResult.Failed(
                    WechatOAuthFailure.AUTHORIZATION_LAUNCH_FAILED,
                )
            }
            if (!runCatching { session.registerApp() }.getOrDefault(false)) {
                coordinator.cancel()
                activeAttempt = null
                safeDetach(session)
                return@synchronized WechatOAuthStartResult.Failed(
                    WechatOAuthFailure.SDK_REGISTRATION_FAILED,
                )
            }
            if (!runCatching { session.isWechatInstalled() }.getOrDefault(false)) {
                coordinator.cancel()
                activeAttempt = null
                safeDetach(session)
                return@synchronized WechatOAuthStartResult.Failed(
                    WechatOAuthFailure.WECHAT_NOT_INSTALLED,
                )
            }
            attempt.session = session
            WechatOAuthRuntimeRegistry.attach(this)
            if (!runCatching { session.sendAuthorization(state) }.getOrDefault(false)) {
                coordinator.cancel()
                activeAttempt = null
                WechatOAuthRuntimeRegistry.detach(this)
                safeDetach(session)
                return@synchronized WechatOAuthStartResult.Failed(
                    WechatOAuthFailure.AUTHORIZATION_LAUNCH_FAILED,
                )
            }
            WechatOAuthStartResult.Started
        }
    }

    /** Called only by the canonical WXEntryActivity in this app process. */
    internal fun handleCallbackIntent(intent: Intent): Boolean {
        val attempt = synchronized(lock) {
            activeAttempt?.takeIf { it.session != null }
        } ?: return false
        val session = checkNotNull(attempt.session)
        val handled = runCatching {
            session.handleIntent(intent) { callback ->
                acceptSdkCallback(attempt.marker, callback)
            }
        }.getOrDefault(false)
        if (!handled) {
            rejectCurrentCallback(attempt.marker, WechatOAuthFailure.INVALID_CALLBACK)
        }
        return handled
    }

    /** Test seam for a callback belonging to the currently active SDK session. */
    internal fun acceptSdkCallback(callback: WechatSdkCallback) {
        val marker = synchronized(lock) { activeAttempt?.marker } ?: return
        acceptSdkCallback(marker, callback)
    }

    /** Clears state/code/session when the account destination is destroyed. */
    internal fun cancelAuthorization() {
        cancelAttempt()
    }

    /**
     * Privacy withdrawal is safe to call repeatedly and never initializes the
     * SDK. A redacted event lets active account orchestration fail closed.
     */
    fun revokePrivacyConsent() {
        val cancelled = synchronized(lock) {
            privacyBlocked = true
            privacyGeneration += 1
            cancelAttemptLocked()
        }
        cancelled?.session?.let(::safeDetach)
        mutableEvents.tryEmit(
            WechatOAuthEvent.Failed(
                purpose = cancelled?.purpose,
                reason = WechatOAuthFailure.PRIVACY_REQUIRED,
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

    private fun acceptSdkCallback(marker: Any, callback: WechatSdkCallback) {
        val resolution = synchronized(lock) {
            val attempt = activeAttempt
                ?.takeIf { it.marker === marker && it.session != null }
                ?: return
            val event = when (callback) {
                is WechatSdkCallback.Authorized -> when (
                    val consumed = coordinator.consume(callback.state, callback.authorizationCode)
                ) {
                    is WechatCoordinatorConsumeResult.Accepted -> WechatOAuthEvent.Authorized(
                        purpose = consumed.purpose,
                        state = consumed.state,
                        authorizationCode = consumed.authorizationCode,
                    )
                    is WechatCoordinatorConsumeResult.Rejected -> WechatOAuthEvent.Failed(
                        purpose = consumed.purpose,
                        reason = consumed.failure,
                    )
                }
                WechatSdkCallback.Cancelled -> WechatOAuthEvent.Failed(
                    purpose = coordinator.cancel(),
                    reason = WechatOAuthFailure.USER_CANCELLED,
                )
                WechatSdkCallback.Denied -> WechatOAuthEvent.Failed(
                    purpose = coordinator.cancel(),
                    reason = WechatOAuthFailure.AUTHORIZATION_DENIED,
                )
                WechatSdkCallback.Invalid -> WechatOAuthEvent.Failed(
                    purpose = coordinator.cancel(),
                    reason = WechatOAuthFailure.INVALID_CALLBACK,
                )
            }
            activeAttempt = null
            WechatOAuthRuntimeRegistry.detach(this)
            CallbackResolution(checkNotNull(attempt.session), event)
        }
        safeDetach(resolution.session)
        mutableEvents.tryEmit(resolution.event)
    }

    private fun rejectCurrentCallback(marker: Any, reason: WechatOAuthFailure) {
        val cancelled = cancelAttempt(marker) ?: return
        mutableEvents.tryEmit(WechatOAuthEvent.Failed(cancelled.purpose, reason))
    }

    private fun cancelAttempt(expectedMarker: Any? = null): CancelledAttempt? {
        val cancelled = synchronized(lock) {
            cancelAttemptLocked(expectedMarker)
        }
        cancelled?.session?.let(::safeDetach)
        return cancelled
    }

    private fun cancelAttemptLocked(expectedMarker: Any? = null): CancelledAttempt? {
        val attempt = activeAttempt
        if (expectedMarker != null && attempt?.marker !== expectedMarker) return null
        val purpose = coordinator.cancel()
        activeAttempt = null
        if (attempt != null) WechatOAuthRuntimeRegistry.detach(this)
        return CancelledAttempt(purpose, attempt?.session)
    }

    private fun safeDetach(session: WechatSdkSession) {
        runCatching { session.detach() }
    }

    private class ActiveAttempt(
        val marker: Any,
        var session: WechatSdkSession? = null,
    )

    private data class CancelledAttempt(
        val purpose: OAuthPurpose?,
        val session: WechatSdkSession?,
    )

    private data class CallbackResolution(
        val session: WechatSdkSession,
        val event: WechatOAuthEvent,
    )
}

/**
 * Callback bridge intentionally lives only in process memory. A restarted
 * process has no active manager and therefore cannot accept an old callback.
 */
internal object WechatOAuthRuntimeRegistry {
    private val lock = Any()
    private var activeManager: WeakReference<WechatOAuthManager>? = null

    fun attach(manager: WechatOAuthManager) = synchronized(lock) {
        activeManager = WeakReference(manager)
    }

    fun active(): WechatOAuthManager? = synchronized(lock) {
        activeManager?.get()
    }

    fun detach(manager: WechatOAuthManager) = synchronized(lock) {
        if (activeManager?.get() === manager) activeManager = null
    }
}
