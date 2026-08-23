package com.chishenme.app.feature.consent

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrivacyConsentCoordinatorTest {
    @Test
    fun `withdrawal closes synchronously and persists before session clear starts`() = runTest {
        val persisted = MutableStateFlow(true)
        val persistEntered = CompletableDeferred<Unit>()
        val releasePersistence = CompletableDeferred<Unit>()
        val clearEntered = CompletableDeferred<Unit>()
        val releaseClear = CompletableDeferred<Unit>()
        val operations = mutableListOf<String>()
        var revoked = 0
        val coordinator = coordinator(
            persisted = persisted,
            persistConsent = { accepted ->
                operations += "persist:$accepted"
                persistEntered.complete(Unit)
                releasePersistence.await()
                persisted.value = accepted
            },
            revokeAuthAttempts = { revoked += 1 },
            clearLocalSession = {
                operations += "clear"
                clearEntered.complete(Unit)
                releaseClear.await()
            },
        )

        assertEquals(true, coordinator.privacyAccepted.value)
        val operation = coordinator.beginWithdrawal()
        assertEquals(false, coordinator.privacyAccepted.value)
        assertEquals(1, revoked)

        val withdrawal = async { coordinator.persistWithdrawalAndClear(operation) }
        persistEntered.await()
        assertEquals(listOf("persist:false"), operations)

        releasePersistence.complete(Unit)
        clearEntered.await()
        assertFalse("durable consent must already be rejected while clear is suspended", persisted.value)
        assertEquals(false, coordinator.privacyAccepted.value)
        assertFalse(withdrawal.isCompleted)

        releaseClear.complete(Unit)
        withdrawal.await()
        assertEquals(listOf("persist:false", "clear"), operations)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `failed session clear cannot undo persisted withdrawal`() = runTest {
        val persisted = MutableStateFlow(true)
        val coordinator = coordinator(
            persisted = persisted,
            persistConsent = { accepted -> persisted.value = accepted },
            clearLocalSession = { throw IOException("Keystore unavailable") },
        )

        val operation = coordinator.beginWithdrawal()
        coordinator.persistWithdrawalAndClear(operation)

        assertFalse(persisted.value)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `process rebuild remains blocked after persisted withdrawal`() = runTest {
        val persisted = MutableStateFlow(false)

        val rebuilt = coordinator(persisted = persisted)
        runCurrent()

        assertEquals(false, rebuilt.privacyAccepted.value)
    }

    @Test
    fun `durable marker keeps a rebuilt process blocked when DataStore withdrawal fails`() = runTest {
        val persisted = MutableStateFlow(true)
        val durableBlocked = MutableStateFlow(false)
        val coordinator = coordinator(
            persisted = persisted,
            durableBlocked = durableBlocked,
            persistConsent = { accepted ->
                assertFalse(accepted)
                throw IOException("DataStore unavailable")
            },
        )

        val operation = coordinator.beginWithdrawal()
        coordinator.persistWithdrawalAndClear(operation)
        assertTrue(durableBlocked.value)
        assertTrue("failed DataStore write leaves the old record unchanged", persisted.value)

        val rebuilt = coordinator(
            persisted = persisted,
            durableBlocked = durableBlocked,
        )
        runCurrent()

        assertEquals(false, rebuilt.privacyAccepted.value)
    }

    @Test
    fun `withdrawal revokes authentication before touching durable storage`() = runTest {
        val operations = mutableListOf<String>()
        val persisted = MutableStateFlow(true)
        val coordinator = coordinator(
            persisted = persisted,
            revokeAuthAttempts = { operations += "revoke" },
            blockWithdrawalDurably = {
                operations += "block"
                true
            },
        )

        coordinator.beginWithdrawal { operations += "external" }

        assertEquals(listOf("revoke", "external", "block"), operations)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `withdrawal cannot be overtaken by stale marker clear`() = runTest {
        val persisted = MutableStateFlow(false)
        val durableBlocked = MutableStateFlow(true)
        val clearEntered = CountDownLatch(1)
        val releaseClear = CountDownLatch(1)
        val coordinator = coordinator(
            persisted = persisted,
            durableBlocked = durableBlocked,
            clearDurableWithdrawalBlock = {
                clearEntered.countDown()
                check(releaseClear.await(5, TimeUnit.SECONDS))
                durableBlocked.value = false
                true
            },
        )

        val acceptance = async(Dispatchers.Default) { coordinator.acceptPrivacy() }
        assertTrue(clearEntered.await(5, TimeUnit.SECONDS))
        val withdrawal = async(Dispatchers.Default) { coordinator.beginWithdrawal() }
        assertFalse("withdrawal must wait for the same finalization lock", withdrawal.isCompleted)
        releaseClear.countDown()

        assertTrue(acceptance.await())
        val withdrawalOperation = withdrawal.await()
        assertTrue(coordinator.persistWithdrawalAndClear(withdrawalOperation))
        assertTrue(durableBlocked.value)
        assertFalse(persisted.value)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `both durable withdrawal channels failing is observable and never reopens process gate`() = runTest {
        val persisted = MutableStateFlow(true)
        val coordinator = coordinator(
            persisted = persisted,
            persistConsent = { accepted ->
                assertFalse(accepted)
                throw IOException("DataStore unavailable")
            },
            blockWithdrawalDurably = { false },
        )

        val operation = coordinator.beginWithdrawal()
        val durable = coordinator.persistWithdrawalAndClear(operation)

        assertFalse(durable)
        assertTrue(persisted.value)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `late acceptance cannot override a newer withdrawal`() = runTest {
        val persisted = MutableStateFlow(false)
        val durableBlocked = MutableStateFlow(false)
        val acceptPersistStarted = CompletableDeferred<Unit>()
        val releaseAcceptPersist = CompletableDeferred<Unit>()
        var allowCount = 0
        val coordinator = coordinator(
            persisted = persisted,
            durableBlocked = durableBlocked,
            persistConsent = { accepted ->
                if (accepted) {
                    acceptPersistStarted.complete(Unit)
                    releaseAcceptPersist.await()
                }
                persisted.value = accepted
            },
            allowAuthAttempts = { allowCount += 1 },
        )
        val acceptance = async { coordinator.acceptPrivacy() }

        acceptPersistStarted.await()
        val withdrawalOperation = coordinator.beginWithdrawal()
        releaseAcceptPersist.complete(Unit)

        assertFalse(acceptance.await())
        coordinator.persistWithdrawalAndClear(withdrawalOperation)
        assertEquals(0, allowCount)
        assertFalse(persisted.value)
        assertTrue(durableBlocked.value)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `failed reaccept write never allows authentication or releases latch`() = runTest {
        val persisted = MutableStateFlow(false)
        val durableBlocked = MutableStateFlow(false)
        var allowCount = 0
        var repositoryCallbacks = 0
        val coordinator = coordinator(
            persisted = persisted,
            durableBlocked = durableBlocked,
            persistConsent = { accepted ->
                assertTrue(accepted)
                throw IOException("DataStore unavailable")
            },
            revokeAuthAttempts = { repositoryCallbacks += 1 },
            allowAuthAttempts = {
                repositoryCallbacks += 1
                allowCount += 1
            },
        )

        assertEquals("construction must not initialize authentication", 0, repositoryCallbacks)
        coordinator.beginWithdrawal()
        val accepted = coordinator.acceptPrivacy()

        assertFalse(accepted)
        assertEquals(0, allowCount)
        assertFalse(persisted.value)
        assertTrue(durableBlocked.value)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `failed marker clear reblocks both durable consent and authentication`() = runTest {
        val persisted = MutableStateFlow(false)
        val durableBlocked = MutableStateFlow(true)
        var allowCount = 0
        var revokeCount = 0
        val coordinator = coordinator(
            persisted = persisted,
            durableBlocked = durableBlocked,
            revokeAuthAttempts = { revokeCount += 1 },
            allowAuthAttempts = { allowCount += 1 },
            clearDurableWithdrawalBlock = {
                durableBlocked.value = false
                false
            },
        )

        val accepted = coordinator.acceptPrivacy()

        assertFalse(accepted)
        assertEquals(0, allowCount)
        assertEquals(1, revokeCount)
        assertFalse(persisted.value)
        assertTrue(durableBlocked.value)
        assertEquals(false, coordinator.privacyAccepted.value)
    }

    @Test
    fun `successful reaccept persists before allowing authentication and releasing latch`() = runTest {
        val persisted = MutableStateFlow(false)
        val durableBlocked = MutableStateFlow(false)
        val operations = mutableListOf<String>()
        var localSessionPresent = true
        lateinit var subject: PrivacyConsentCoordinator
        subject = coordinator(
            persisted = persisted,
            durableBlocked = durableBlocked,
            persistConsent = { accepted ->
                operations += "persist:$accepted"
                persisted.value = accepted
            },
            allowAuthAttempts = {
                operations += "allow"
                assertTrue(persisted.value)
                assertFalse("old local session must be cleared before auth reopens", localSessionPresent)
                assertEquals(
                    "UI latch must still be closed during allow",
                    false,
                    subject.privacyAccepted.value,
                )
            },
            clearLocalSession = {
                operations += "clear"
                localSessionPresent = false
            },
        )

        subject.beginWithdrawal()
        val accepted = subject.acceptPrivacy()

        assertTrue(accepted)
        assertEquals(listOf("persist:true", "clear", "allow"), operations)
        assertFalse(durableBlocked.value)
        assertEquals(true, subject.privacyAccepted.value)
    }

    private fun kotlinx.coroutines.test.TestScope.coordinator(
        persisted: MutableStateFlow<Boolean>,
        persistConsent: suspend (Boolean) -> Unit = { accepted -> persisted.value = accepted },
        revokeAuthAttempts: () -> Unit = {},
        allowAuthAttempts: () -> Unit = {},
        clearLocalSession: suspend () -> Unit = {},
        durableBlocked: MutableStateFlow<Boolean> = MutableStateFlow(false),
        blockWithdrawalDurably: (() -> Boolean)? = null,
        clearDurableWithdrawalBlock: (() -> Boolean)? = null,
    ): PrivacyConsentCoordinator = PrivacyConsentCoordinator(
        persistedConsent = persisted,
        persistConsent = persistConsent,
        revokeAuthAttempts = revokeAuthAttempts,
        allowAuthAttempts = {
            allowAuthAttempts()
            true
        },
        clearLocalSession = clearLocalSession,
        durableWithdrawalBlocked = { durableBlocked.value },
        blockWithdrawalDurably = blockWithdrawalDurably ?: {
            durableBlocked.value = true
            true
        },
        clearDurableWithdrawalBlock = clearDurableWithdrawalBlock ?: {
            durableBlocked.value = false
            true
        },
        scope = backgroundScope,
    )
}
