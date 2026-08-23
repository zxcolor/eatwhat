package com.chishenme.app.feature.consent

import android.annotation.SuppressLint
import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.FileOutputStream
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A synchronous, process-independent fail-closed marker for privacy withdrawal.
 *
 * DataStore remains the consent source of record. This tiny marker closes the
 * restart window before the suspending DataStore transaction can commit. It is
 * cleared only after a later consent write and the authentication gate both
 * succeed.
 */
@Singleton
class PrivacyWithdrawalMarkerStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val preferences = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    private val allowMarker = File(context.noBackupFilesDir, ALLOW_MARKER_FILE)
    private val allowMarkerTemp = File(context.noBackupFilesDir, "$ALLOW_MARKER_FILE.tmp")

    fun isBlocked(): Boolean = try {
        preferences.getBoolean(BLOCKED_KEY, true) || !hasValidAllowMarker()
    } catch (_: Exception) {
        true
    }

    @SuppressLint("ApplySharedPref")
    fun block(): Boolean {
        // Invalidate the positive allow proof first. Missing/partial files are
        // fail-closed, so a process stop anywhere after this point cannot reopen.
        val fileBlocked = invalidateAllowMarker()
        val preferenceBlocked = try {
            preferences.edit().putBoolean(BLOCKED_KEY, true).commit()
        } catch (_: Exception) {
            false
        }
        // Either independently durable channel is sufficient to keep
        // isBlocked() fail-closed after a process restart.
        return preferenceBlocked || fileBlocked
    }

    @SuppressLint("ApplySharedPref")
    fun clear(): Boolean {
        if (!writeAllowMarkerAtomically()) return false
        val preferenceAllowed = try {
            preferences.edit().putBoolean(BLOCKED_KEY, false).commit()
        } catch (_: Exception) {
            false
        }
        if (!preferenceAllowed) {
            invalidateAllowMarker()
            return false
        }
        return !isBlocked()
    }

    private fun hasValidAllowMarker(): Boolean = try {
        allowMarker.isFile &&
            allowMarker.length() == ALLOW_MARKER_BYTES.size.toLong() &&
            allowMarker.readBytes().contentEquals(ALLOW_MARKER_BYTES)
    } catch (_: Exception) {
        false
    }

    private fun invalidateAllowMarker(): Boolean = try {
        if (allowMarkerTemp.exists()) allowMarkerTemp.delete()
        val markerInvalidated = !allowMarker.exists() || allowMarker.delete()
        markerInvalidated
    } catch (_: Exception) {
        false
    }

    private fun writeAllowMarkerAtomically(): Boolean {
        return try {
            if (allowMarkerTemp.exists() && !allowMarkerTemp.delete()) return false
            FileOutputStream(allowMarkerTemp).use { output ->
                output.write(ALLOW_MARKER_BYTES)
                output.flush()
                output.fd.sync()
            }
            if (allowMarker.exists() && !allowMarker.delete()) {
                allowMarkerTemp.delete()
                return false
            }
            if (!allowMarkerTemp.renameTo(allowMarker)) {
                allowMarkerTemp.delete()
                return false
            }
            hasValidAllowMarker()
        } catch (_: Exception) {
            allowMarkerTemp.delete()
            false
        }
    }

    private companion object {
        const val FILE_NAME = "privacy_withdrawal_gate_v1"
        const val BLOCKED_KEY = "withdrawal_pending"
        const val ALLOW_MARKER_FILE = "privacy_consent_allow_v1"
        val ALLOW_MARKER_BYTES = "privacy-consent-allow-v1\n".toByteArray(Charsets.UTF_8)
    }
}
