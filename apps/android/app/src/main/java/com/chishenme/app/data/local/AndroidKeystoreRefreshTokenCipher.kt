package com.chishenme.app.data.local

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.inject.Inject
import javax.inject.Singleton

internal class AuthCipherException : Exception("本机安全存储不可用")

internal interface RefreshTokenCipher {
    fun encrypt(plaintext: String, associatedData: ByteArray): String

    fun decrypt(envelope: String, associatedData: ByteArray): String

    fun deleteKey()
}

/**
 * Refresh tokens are encrypted by a non-exportable Android Keystore AES key.
 * No key, token, cipher failure detail, or plaintext is ever logged.
 */
@Singleton
internal class AndroidKeystoreRefreshTokenCipher @Inject constructor() : RefreshTokenCipher {
    override fun encrypt(plaintext: String, associatedData: ByteArray): String = protect {
        require(plaintext.matches(OPAQUE_TOKEN))
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(associatedData)
        val plaintextBytes = plaintext.toByteArray(Charsets.UTF_8)
        try {
            val ciphertext = cipher.doFinal(plaintextBytes)
            require(cipher.iv.size == GCM_IV_BYTES)
            listOf(
                ENVELOPE_VERSION,
                cipher.iv.toBase64Url(),
                ciphertext.toBase64Url(),
            ).joinToString(":")
        } finally {
            plaintextBytes.fill(0)
        }
    }

    override fun decrypt(envelope: String, associatedData: ByteArray): String = protect {
        val parts = envelope.split(':', limit = 4)
        require(parts.size == 3 && parts[0] == ENVELOPE_VERSION)
        val iv = parts[1].fromBase64Url(MAX_IV_BYTES)
        val ciphertext = parts[2].fromBase64Url(MAX_CIPHERTEXT_BYTES)
        require(iv.size == GCM_IV_BYTES && ciphertext.isNotEmpty())

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            existingKey() ?: throw AuthCipherException(),
            javax.crypto.spec.GCMParameterSpec(GCM_TAG_BITS, iv),
        )
        cipher.updateAAD(associatedData)
        val plaintextBytes = cipher.doFinal(ciphertext)
        try {
            val plaintext = plaintextBytes.toString(Charsets.UTF_8)
            require(plaintext.matches(OPAQUE_TOKEN))
            plaintext
        } finally {
            plaintextBytes.fill(0)
        }
    }

    override fun deleteKey() {
        runCatching {
            val keyStore = keyStore()
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
        }
    }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun getOrCreateKey(): SecretKey = existingKey() ?: KeyGenerator
        .getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        .apply {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
        }
        .generateKey()

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    private inline fun <T> protect(block: () -> T): T = try {
        block()
    } catch (error: AuthCipherException) {
        throw error
    } catch (_: Exception) {
        throw AuthCipherException()
    }

    private fun ByteArray.toBase64Url(): String = Base64.encodeToString(
        this,
        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
    )

    private fun String.fromBase64Url(maximumBytes: Int): ByteArray {
        require(length in 1..(maximumBytes * 2))
        require(matches(BASE64URL))
        val decoded = Base64.decode(
            this,
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
        require(decoded.size <= maximumBytes)
        return decoded
    }

    private companion object {
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val KEY_ALIAS = "chi_shen_me_auth_refresh_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val ENVELOPE_VERSION = "v1"
        const val GCM_IV_BYTES = 12
        const val GCM_TAG_BITS = 128
        const val MAX_IV_BYTES = 32
        const val MAX_CIPHERTEXT_BYTES = 128
        val OPAQUE_TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
        val BASE64URL = Regex("^[A-Za-z0-9_-]+$")
    }
}
