package com.chishenme.app.feature.detail

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import com.chishenme.app.BuildConfig
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.feature.session.ResultSessionState
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal enum class RestaurantShareOutcome {
    STARTED,
    NOT_ALLOWED,
    GENERATION_FAILED,
    NO_TARGET,
}

internal object AndroidRestaurantActions {
    fun openNavigation(
        context: Context,
        result: RecommendationResult,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): Boolean {
        return openNavigation(context, result.toRestaurantDisplayModel(), sessionState)
    }

    fun openNavigation(
        context: Context,
        result: RestaurantDisplayModel,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): Boolean {
        val liveState = sessionState.failClosed()
        if (!RestaurantActionAvailabilityPolicy.evaluate(result, liveState).navigate.enabled) return false
        val action = RestaurantActionFactory.navigation(result) ?: return false
        if (sessionState.failClosed() != ResultSessionState.CURRENT) return false
        return launch(
            context = context,
            intent = Intent(Intent.ACTION_VIEW, action.uri.toUri()),
        )
    }

    fun dial(
        context: Context,
        result: RecommendationResult,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): Boolean {
        return dial(context, result.toRestaurantDisplayModel(), sessionState)
    }

    fun dial(
        context: Context,
        result: RestaurantDisplayModel,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): Boolean {
        val liveState = sessionState.failClosed()
        if (!RestaurantActionAvailabilityPolicy.evaluate(result, liveState).call.enabled) return false
        val action = RestaurantActionFactory.dial(result) ?: return false
        if (sessionState.failClosed() != ResultSessionState.CURRENT) return false
        return launch(
            context = context,
            intent = Intent(Intent.ACTION_DIAL, action.uri.toUri()),
        )
    }

    fun copyAddress(
        context: Context,
        result: RecommendationResult,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): Boolean {
        return copyAddress(context, result.toRestaurantDisplayModel(), sessionState)
    }

    fun copyAddress(
        context: Context,
        result: RestaurantDisplayModel,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): Boolean {
        val liveState = sessionState.failClosed()
        if (!RestaurantActionAvailabilityPolicy.evaluate(result, liveState).copyAddress.enabled) return false
        val action = RestaurantActionFactory.clipboard(result) ?: return false
        if (sessionState.failClosed() != ResultSessionState.CURRENT) return false
        return runCatching {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText(action.label, action.text))
        }.isSuccess
    }

    suspend fun share(
        context: Context,
        result: RecommendationResult,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): RestaurantShareOutcome = shareInternal(
        context = context,
        result = result,
        sessionState = sessionState,
        ioDispatcher = Dispatchers.IO,
        generateCard = { cacheDirectory, candidate ->
            RestaurantShareCardGenerator().generate(cacheDirectory, candidate)
        },
    )

    /**
     * Test seam for cancellation and revocation races. Production always uses
     * [RestaurantShareCardGenerator] through [share].
     */
    internal suspend fun shareWithGenerator(
        context: Context,
        result: RecommendationResult,
        sessionState: () -> ResultSessionState,
        ioDispatcher: CoroutineDispatcher,
        generateCard: (File, RecommendationResult) -> File?,
    ): RestaurantShareOutcome = shareInternal(
        context = context,
        result = result,
        sessionState = sessionState,
        ioDispatcher = ioDispatcher,
        generateCard = generateCard,
    )

    /**
     * Safe hook for cold start and foreground entry. It removes only expired
     * files created by this module inside its dedicated cache subtree.
     */
    suspend fun cleanupResidualShareCards(context: Context): Int {
        val cacheDirectory = try {
            context.cacheDir
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return 0
        } catch (_: OutOfMemoryError) {
            return 0
        }
        return try {
            withContext(Dispatchers.IO) {
                RestaurantShareCardStore(cacheDirectory).cleanupExpired()
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            0
        } catch (_: OutOfMemoryError) {
            0
        }
    }

    private suspend fun shareInternal(
        context: Context,
        result: RecommendationResult,
        sessionState: () -> ResultSessionState,
        ioDispatcher: CoroutineDispatcher,
        generateCard: (File, RecommendationResult) -> File?,
    ): RestaurantShareOutcome {
        if (!BuildConfig.SHARE_FEATURE_ENABLED) return RestaurantShareOutcome.NOT_ALLOWED
        val initialState = sessionState.failClosed()
        if (!RestaurantActionAvailabilityPolicy.evaluate(result, initialState).share.enabled) {
            Log.d(SHARE_DIAGNOSTIC_TAG, "initial_not_allowed:$initialState")
            return RestaurantShareOutcome.NOT_ALLOWED
        }

        val cacheDirectory = try {
            context.cacheDir
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return RestaurantShareOutcome.GENERATION_FAILED
        } catch (_: OutOfMemoryError) {
            return RestaurantShareOutcome.GENERATION_FAILED
        }
        val generationLease = RestaurantShareCardStore.generationLease(cacheDirectory)
        val cardFile = try {
            val generated = withContext(ioDispatcher) {
                RestaurantShareCardStore.withGenerationLease(generationLease) {
                    generateCard(cacheDirectory, result)
                }
            }
            generated.takeIf(generationLease::owns) ?: run {
                generationLease.discard()
                null
            }
        } catch (cancellation: CancellationException) {
            // withContext has prompt cancellation: the renderer may have
            // completed its file after the caller was cancelled, without ever
            // returning that File to this stack frame. The cross-dispatcher
            // lease still owns and removes exactly that output.
            generationLease.discard()
            throw cancellation
        } catch (_: Exception) {
            generationLease.discard()
            null
        } catch (_: OutOfMemoryError) {
            generationLease.discard()
            null
        } ?: run {
            Log.d(SHARE_DIAGNOSTIC_TAG, "generation_failed")
            return RestaurantShareOutcome.GENERATION_FAILED
        }

        // Card rendering happens off the main thread. Authorization or the
        // result session may have changed while it was being generated.
        if (sessionState.failClosed() != ResultSessionState.CURRENT) {
            Log.d(SHARE_DIAGNOSTIC_TAG, "revoked_after_generation")
            generationLease.discard()
            return RestaurantShareOutcome.NOT_ALLOWED
        }

        val chooser = try {
            val contentUri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.share-file-provider",
                cardFile,
            )
            RestaurantShareIntentFactory.createChooser(context, contentUri)
        } catch (_: Exception) {
            null
        } catch (_: OutOfMemoryError) {
            null
        } ?: run {
            Log.d(SHARE_DIAGNOSTIC_TAG, "chooser_generation_failed")
            generationLease.discard()
            return RestaurantShareOutcome.GENERATION_FAILED
        }

        // Re-check immediately before crossing the Android outbound boundary.
        if (sessionState.failClosed() != ResultSessionState.CURRENT) {
            Log.d(SHARE_DIAGNOSTIC_TAG, "revoked_before_launch")
            generationLease.discard()
            return RestaurantShareOutcome.NOT_ALLOWED
        }

        // No suspension exists between this final check and startActivity. Once
        // the chooser starts, the recipient temporarily owns read access and the
        // file must remain available until the residual TTL cleanup.
        check(generationLease.release(cardFile)) { "Share-card generation ownership was lost" }
        return if (launch(context, chooser)) {
            Log.d(SHARE_DIAGNOSTIC_TAG, "started:${context.javaClass.name}")
            RestaurantShareOutcome.STARTED
        } else {
            Log.d(SHARE_DIAGNOSTIC_TAG, "no_target:${context.javaClass.name}")
            cardFile.delete()
            RestaurantShareOutcome.NO_TARGET
        }
    }

    fun shareText(
        context: Context,
        result: RestaurantDisplayModel,
        sessionState: () -> ResultSessionState = { ResultSessionState.CURRENT },
    ): Boolean {
        if (!BuildConfig.SHARE_FEATURE_ENABLED) return false
        val liveState = sessionState.failClosed()
        if (!RestaurantActionAvailabilityPolicy.evaluate(result, liveState).share.enabled) return false
        val text = RestaurantActionFactory.shareText(result) ?: return false
        val shareIntent = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, text)
        if (sessionState.failClosed() != ResultSessionState.CURRENT) return false
        return launch(context, Intent.createChooser(shareIntent, "分享餐厅信息"))
    }

    private fun launch(context: Context, intent: Intent): Boolean =
        runCatching { context.startActivity(intent) }.isSuccess

    private fun (() -> ResultSessionState).failClosed(): ResultSessionState =
        runCatching { invoke() }.getOrDefault(ResultSessionState.EXPIRED)

    private const val SHARE_DIAGNOSTIC_TAG = "ChiShenMeShareDiag"
}
