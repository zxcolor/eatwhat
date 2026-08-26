package com.chishenme.app.auth.fusion

import android.app.Activity
import com.chishenme.app.data.remote.FusionAuthPurpose
import com.chishenme.app.data.remote.FusionAuthTokenResponse
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

internal interface FusionAuthSdkFactory {
    /** This probe must not load or initialize any third-party SDK class. */
    val available: Boolean

    /** Called only after consent, server capability and a user gesture were verified. */
    fun create(): FusionAuthSdk?
}

internal interface FusionAuthSdk {
    fun start(
        activity: Activity,
        schemeCode: String,
        authToken: String,
        listener: FusionAuthSdkListener,
    ): Boolean

    fun cancel()
}

internal interface FusionAuthSdkListener {
    fun onProof(verifyToken: String, completion: FusionAuthProofCompletion)

    fun onFailure()

    fun onFinished()
}

internal interface FusionAuthHost {
    val isAvailable: Boolean

    fun launch(
        sdk: FusionAuthSdk,
        schemeCode: String,
        authToken: String,
        listener: FusionAuthSdkListener,
    ): Boolean
}

internal fun Activity.toFusionAuthHost(): FusionAuthHost = object : FusionAuthHost {
    override val isAvailable: Boolean
        get() = !isFinishing && !isDestroyed

    override fun launch(
        sdk: FusionAuthSdk,
        schemeCode: String,
        authToken: String,
        listener: FusionAuthSdkListener,
    ): Boolean = sdk.start(this@toFusionAuthHost, schemeCode, authToken, listener)
}

/** Completes either a full SDK node or an intermediate global-strategy node. */
internal fun interface FusionAuthProofCompletion {
    fun complete(success: Boolean)
}

/**
 * A provider verification token is deliberately an in-memory, single-read value.
 * It cannot be copied through data classes, persisted, rendered, or revealed by toString().
 */
internal class OneTimeFusionVerifyToken private constructor(value: String) {
    private val value = AtomicReference(value)

    fun consume(): String? = value.getAndSet(null)

    fun discard() {
        value.set(null)
    }

    override fun toString(): String = "OneTimeFusionVerifyToken(REDACTED)"

    companion object {
        private val pattern = Regex("^[^\\s\\u0000-\\u001F\\u007F]{1,4096}$")

        fun from(value: String): OneTimeFusionVerifyToken? =
            value.takeIf(pattern::matches)?.let(::OneTimeFusionVerifyToken)
    }
}

internal sealed interface FusionAuthEvent {
    val sessionId: String
    val configurationGeneration: Long

    class ProofReady(
        override val sessionId: String,
        override val configurationGeneration: Long,
        val purpose: FusionAuthPurpose,
        val flowId: String,
        val proofId: String,
        val verifyToken: OneTimeFusionVerifyToken,
    ) : FusionAuthEvent {
        override fun toString(): String =
            "ProofReady(sessionId=$sessionId, generation=$configurationGeneration, " +
                "purpose=$purpose, flowId=$flowId, proofId=$proofId, verifyToken=REDACTED)"
    }

    data class Failed(
        override val sessionId: String,
        override val configurationGeneration: Long,
    ) : FusionAuthEvent

    data class SceneCompleted(
        override val sessionId: String,
        override val configurationGeneration: Long,
        val purpose: FusionAuthPurpose,
    ) : FusionAuthEvent

    data object PrivacyRevoked : FusionAuthEvent {
        override val sessionId: String = "privacy-revoked"
        override val configurationGeneration: Long = -1L
    }
}

internal sealed interface FusionAuthStartResult {
    data class Started(val sessionId: String) : FusionAuthStartResult

    enum class Rejected : FusionAuthStartResult {
        PRIVACY_REQUIRED,
        SERVER_DISABLED,
        CLIENT_UNAVAILABLE,
        INVALID_TOKEN,
        HOST_UNAVAILABLE,
        BUSY,
        SDK_FAILURE,
    }
}

internal data class FusionAuthSession(
    val sessionId: String,
    val configurationGeneration: Long,
    val purpose: FusionAuthPurpose,
    val flowId: String,
    val sdk: FusionAuthSdk,
    var pendingProof: PendingFusionProof? = null,
    var acceptedProofId: String? = null,
)

internal data class PendingFusionProof(
    val proofId: String,
    val token: OneTimeFusionVerifyToken,
    val completion: FusionAuthProofCompletion,
)

@Singleton
class FusionAuthManager @Inject internal constructor(
    private val factory: FusionAuthSdkFactory,
    private val privacyAuthorizationGate: PrivacyAuthorizationGate,
) {
    private val lock = Any()
    private var activeSession: FusionAuthSession? = null
    private val mutableEvents = MutableSharedFlow<FusionAuthEvent>(extraBufferCapacity = 8)
    internal val events: SharedFlow<FusionAuthEvent> = mutableEvents.asSharedFlow()

    internal val clientAvailable: Boolean
        get() = factory.available

    internal val hasActiveSession: Boolean
        get() = synchronized(lock) { activeSession != null }

    internal val activePurpose: FusionAuthPurpose?
        get() = synchronized(lock) { activeSession?.purpose }

    internal val activeConfigurationGeneration: Long?
        get() = synchronized(lock) { activeSession?.configurationGeneration }

    internal val activeSessionId: String?
        get() = synchronized(lock) { activeSession?.sessionId }

    /**
     * This is the only SDK creation path. The caller invokes it only from the explicit
     * one-click-login/register button after fetching a server-owned token.
     */
    internal suspend fun start(
        host: FusionAuthHost,
        configurationGeneration: Long,
        purpose: FusionAuthPurpose,
        serverEnabled: Boolean,
        token: FusionAuthTokenResponse,
    ): FusionAuthStartResult {
        if (!serverEnabled) return FusionAuthStartResult.Rejected.SERVER_DISABLED
        if (!factory.available) return FusionAuthStartResult.Rejected.CLIENT_UNAVAILABLE
        if (!privacyAccepted()) return FusionAuthStartResult.Rejected.PRIVACY_REQUIRED
        if (!host.isAvailable) return FusionAuthStartResult.Rejected.HOST_UNAVAILABLE
        if (!token.isUsable()) return FusionAuthStartResult.Rejected.INVALID_TOKEN
        synchronized(lock) {
            if (activeSession != null) return FusionAuthStartResult.Rejected.BUSY
        }

        // No vendor class is touched before every gate above has passed.
        val sdk = try {
            factory.create()
        } catch (_: Exception) {
            null
        } ?: return FusionAuthStartResult.Rejected.SDK_FAILURE

        if (!privacyAccepted()) {
            runCatching { sdk.cancel() }
            return FusionAuthStartResult.Rejected.PRIVACY_REQUIRED
        }

        val session = FusionAuthSession(
            sessionId = UUID.randomUUID().toString(),
            configurationGeneration = configurationGeneration,
            purpose = purpose,
            flowId = token.flowId,
            sdk = sdk,
        )
        synchronized(lock) {
            if (activeSession != null) {
                runCatching { sdk.cancel() }
                return FusionAuthStartResult.Rejected.BUSY
            }
            activeSession = session
        }

        val started = try {
            host.launch(
                sdk = sdk,
                schemeCode = token.schemeCode,
                authToken = token.authToken,
                listener = listenerFor(session.sessionId),
            )
        } catch (_: Exception) {
            false
        }
        if (!started || !privacyAccepted()) {
            cancelSession(session.sessionId)
            return if (!started) {
                FusionAuthStartResult.Rejected.SDK_FAILURE
            } else {
                FusionAuthStartResult.Rejected.PRIVACY_REQUIRED
            }
        }
        return FusionAuthStartResult.Started(session.sessionId)
    }

    /** The repository result may complete a proof only once and only for the current session. */
    internal fun completeProof(proofId: String, success: Boolean) {
        val pending = synchronized(lock) {
            val session = activeSession ?: return
            val current = session.pendingProof?.takeIf { it.proofId == proofId } ?: return
            session.pendingProof = null
            if (success) session.acceptedProofId = proofId
            current
        }
        pending.token.discard()
        try {
            pending.completion.complete(success)
        } catch (_: Exception) {
            cancel()
        }
    }

    internal fun cancelForConfigurationChange(configurationGeneration: Long) {
        val session = synchronized(lock) { activeSession }
        if (session != null && session.configurationGeneration != configurationGeneration) {
            cancelSession(session.sessionId)
        }
    }

    fun revokePrivacyConsent() {
        mutableEvents.tryEmit(FusionAuthEvent.PrivacyRevoked)
        cancel()
    }

    fun cancel() {
        val sessionId = synchronized(lock) { activeSession?.sessionId } ?: return
        cancelSession(sessionId)
    }

    /**
     * A whole-process background transition is terminal for the current scene.
     * Unlike a silent owner cleanup, it must notify the account state machine so
     * its busy state is released immediately when the user returns to the app.
     */
    internal fun cancelForBackground() {
        val sessionId = synchronized(lock) { activeSession?.sessionId } ?: return
        val session = cancelSession(sessionId) ?: return
        mutableEvents.tryEmit(
            FusionAuthEvent.Failed(
                sessionId = session.sessionId,
                configurationGeneration = session.configurationGeneration,
            ),
        )
    }

    private fun listenerFor(sessionId: String): FusionAuthSdkListener =
        object : FusionAuthSdkListener {
            override fun onProof(
                verifyToken: String,
                completion: FusionAuthProofCompletion,
            ) {
                val token = OneTimeFusionVerifyToken.from(verifyToken)
                if (token == null) {
                    runCatching { completion.complete(false) }
                    failSession(sessionId)
                    return
                }
                val event = synchronized(lock) {
                    val session = activeSession?.takeIf { it.sessionId == sessionId }
                    if (
                        session == null ||
                        session.pendingProof != null ||
                        session.acceptedProofId != null
                    ) {
                        null
                    } else {
                        val proofId = UUID.randomUUID().toString()
                        session.pendingProof = PendingFusionProof(proofId, token, completion)
                        FusionAuthEvent.ProofReady(
                            sessionId = session.sessionId,
                            configurationGeneration = session.configurationGeneration,
                            purpose = session.purpose,
                            flowId = session.flowId,
                            proofId = proofId,
                            verifyToken = token,
                        )
                    }
                }
                if (event == null || !mutableEvents.tryEmit(event)) {
                    token.discard()
                    runCatching { completion.complete(false) }
                    failSession(sessionId)
                }
            }

            override fun onFailure() = failSession(sessionId)

            override fun onFinished() = finishSession(sessionId)
        }

    private fun finishSession(sessionId: String) {
        val event = synchronized(lock) {
            val session = activeSession?.takeIf { it.sessionId == sessionId } ?: return
            if (session.acceptedProofId != null) {
                FusionAuthEvent.SceneCompleted(
                    sessionId = session.sessionId,
                    configurationGeneration = session.configurationGeneration,
                    purpose = session.purpose,
                )
            } else {
                FusionAuthEvent.Failed(session.sessionId, session.configurationGeneration)
            }
        }
        mutableEvents.tryEmit(event)
        cancelSession(sessionId)
    }

    private fun failSession(sessionId: String) {
        val event = synchronized(lock) {
            val session = activeSession?.takeIf { it.sessionId == sessionId } ?: return
            FusionAuthEvent.Failed(session.sessionId, session.configurationGeneration)
        }
        mutableEvents.tryEmit(event)
        cancelSession(sessionId)
    }

    private fun cancelSession(sessionId: String): FusionAuthSession? {
        val session = synchronized(lock) {
            val current = activeSession?.takeIf { it.sessionId == sessionId } ?: return null
            activeSession = null
            current
        }
        session.pendingProof?.token?.discard()
        runCatching { session.pendingProof?.completion?.complete(false) }
        runCatching { session.sdk.cancel() }
        return session
    }

    private suspend fun privacyAccepted(): Boolean = try {
        privacyAuthorizationGate.isAccepted()
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        false
    }

    private fun FusionAuthTokenResponse.isUsable(): Boolean {
        val expiry = runCatching { Instant.parse(expiresAt) }.getOrNull() ?: return false
        return AuthTokenPatterns.flowId.matches(flowId) &&
            AuthTokenPatterns.schemeCode.matches(schemeCode) &&
            AuthTokenPatterns.authToken.matches(authToken) &&
            expiry.isAfter(Instant.now())
    }

    private object AuthTokenPatterns {
        val flowId = Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )
        val schemeCode = Regex("^[A-Za-z0-9_-]{1,128}$")
        val authToken = Regex("^[^\\s\\u0000-\\u001F\\u007F]{1,4096}$")
    }
}
