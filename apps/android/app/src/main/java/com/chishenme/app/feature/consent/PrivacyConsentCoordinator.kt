package com.chishenme.app.feature.consent

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Keeps the in-process privacy gate closed while its durable state is changing.
 * Authentication dependencies are supplied as callbacks so merely constructing
 * the first-run consent screen cannot initialize the authentication graph.
 */
internal class PrivacyConsentCoordinator(
    persistedConsent: Flow<Boolean>,
    private val persistConsent: suspend (Boolean) -> Unit,
    private val revokeAuthAttempts: () -> Unit,
    private val allowAuthAttempts: () -> Boolean,
    private val clearLocalSession: suspend () -> Unit,
    durableWithdrawalBlocked: () -> Boolean,
    private val blockWithdrawalDurably: () -> Boolean,
    private val clearDurableWithdrawalBlock: () -> Boolean,
    scope: CoroutineScope,
) {
    private val operationLock = Any()
    private val operationMutex = Mutex()
    private var operationGeneration = 0L
    private val withdrawalLatched = AtomicBoolean(
        try {
            durableWithdrawalBlocked()
        } catch (_: Exception) {
            true
        },
    )
    private val mutablePrivacyAccepted = MutableStateFlow<Boolean?>(null)
    val privacyAccepted: StateFlow<Boolean?> = mutablePrivacyAccepted.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            persistedConsent.collect { accepted ->
                mutablePrivacyAccepted.value = accepted && !withdrawalLatched.get()
            }
        }
    }

    /** Closes every process gate before performing any potentially blocking disk I/O. */
    fun beginWithdrawal(
        revokeExternalAuthorization: () -> Unit = {},
    ): PrivacyWithdrawalOperation = synchronized(operationLock) {
        operationGeneration += 1L
        withdrawalLatched.set(true)
        mutablePrivacyAccepted.value = false
        try {
            revokeAuthAttempts()
        } catch (_: Exception) {
            // The shared process gate is invoked first by the production callback;
            // durable withdrawal and local credential cleanup must still run.
        }
        try {
            revokeExternalAuthorization()
        } catch (_: Exception) {
            // Native provider cancellation is best effort, but it must be
            // attempted before the first marker disk operation.
        }
        // Synchronous commit closes the process-restart window before this
        // callback returns or any suspending DataStore operation begins.
        val markerBlocked = try {
            blockWithdrawalDurably()
        } catch (_: Exception) {
            false
        }
        PrivacyWithdrawalOperation(operationGeneration, markerBlocked)
    }

    /**
     * The consent edit is deliberately the first suspending operation in this
     * block. AppPreferences performs that edit atomically with removal of the
     * DataStore session material; Keystore/session cleanup then gets its own
     * independent attempt and cannot reopen the latch if it fails.
     */
    suspend fun persistWithdrawalAndClear(
        operation: PrivacyWithdrawalOperation,
    ): Boolean = withContext(NonCancellable) {
        operationMutex.withLock {
            if (!isCurrent(operation.generation)) return@withLock true
            // Retry the synchronous marker before touching the consent record.
            val markerBlocked = operation.markerBlocked || try {
                blockWithdrawalDurably()
            } catch (_: Exception) {
                false
            }
            val consentBlocked = try {
                persistConsent(false)
                true
            } catch (_: Exception) {
                // The durable marker and process-local latch remain closed.
                false
            }
            try {
                clearLocalSession()
            } catch (_: Exception) {
                // Persisted consent or the durable marker is already fail-closed.
            }
            markerBlocked || consentBlocked
        }
    }

    /** Returns false without releasing either gate when the durable write fails. */
    suspend fun acceptPrivacy(): Boolean {
        val operation = synchronized(operationLock) {
            operationGeneration += 1L
            withdrawalLatched.set(true)
            mutablePrivacyAccepted.value = false
            operationGeneration
        }
        return operationMutex.withLock {
            if (!isCurrent(operation)) return@withLock false
            try {
                persistConsent(true)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                return@withLock false
            }

            if (!isCurrent(operation)) return@withLock false
            val localSessionCleared = try {
                // A process may have stopped after the withdrawal marker was
                // committed but before its old refresh material was removed.
                // Never clear that marker and re-open auth until cleanup has
                // completed in the current process.
                clearLocalSession()
                true
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                false
            }
            if (!localSessionCleared) {
                failClosedAfterAcceptance()
                return@withLock false
            }

            val allowed: Boolean? = synchronized(operationLock) {
                if (operationGeneration != operation) return@synchronized null
                val markerCleared = try {
                    clearDurableWithdrawalBlock()
                } catch (_: Exception) {
                    false
                }
                if (!markerCleared) return@synchronized false
                val opened = try {
                    allowAuthAttempts()
                } catch (_: Exception) {
                    false
                }
                if (!opened) {
                    try {
                        revokeAuthAttempts()
                    } catch (_: Exception) {
                        // The durable rollback below remains fail-closed.
                    }
                    return@synchronized false
                }
                withdrawalLatched.set(false)
                mutablePrivacyAccepted.value = true
                true
            }
            when (allowed) {
                null -> false
                false -> {
                    failClosedAfterAcceptance()
                    false
                }
                true -> true
            }
        }
    }

    private suspend fun failClosedAfterAcceptance() = withContext(NonCancellable) {
        try {
            revokeAuthAttempts()
        } catch (_: Exception) {
            // Continue with both durable rollback channels.
        }
        try {
            blockWithdrawalDurably()
        } catch (_: Exception) {
            false
        }
        try {
            persistConsent(false)
        } catch (_: Exception) {
            // The process latch and redundant durable marker remain closed.
        }
        try {
            clearLocalSession()
        } catch (_: Exception) {
            // A later retry may finish local cleanup; authorization stays closed.
        }
    }

    private fun isCurrent(operation: Long): Boolean = synchronized(operationLock) {
        operationGeneration == operation
    }
}

internal data class PrivacyWithdrawalOperation(
    val generation: Long,
    val markerBlocked: Boolean,
)
