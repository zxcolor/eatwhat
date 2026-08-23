package com.chishenme.app.feature.detail

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri

internal data class RestaurantShareIntentSpec(
    val action: String,
    val mimeType: String,
    val streamUri: String,
    val chooserTitle: String,
    val grantReadPermission: Boolean,
)

/** Constructs an image-only send Intent with a temporary read grant. */
internal object RestaurantShareIntentFactory {
    fun createSpec(contentUri: String): RestaurantShareIntentSpec? {
        if (!contentUri.startsWith("content://") || contentUri.any(Char::isWhitespace)) return null
        return RestaurantShareIntentSpec(
            action = ACTION_SEND,
            mimeType = MIME_TYPE_PNG,
            streamUri = contentUri,
            chooserTitle = "分享推荐卡",
            grantReadPermission = true,
        )
    }

    fun createChooser(context: Context, contentUri: Uri): Intent? {
        val spec = createSpec(contentUri.toString()) ?: return null
        val sendIntent = Intent(spec.action).apply {
            type = spec.mimeType
            putExtra(Intent.EXTRA_STREAM, contentUri)
            // ClipData is needed for reliable URI permission propagation on
            // older receivers; it contains the same single private URI.
            clipData = ClipData.newUri(context.contentResolver, "吃什么推荐卡", contentUri)
            if (spec.grantReadPermission) addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(sendIntent, spec.chooserTitle).apply {
            if (spec.grantReadPermission) addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    private const val MIME_TYPE_PNG = "image/png"
    private const val ACTION_SEND = "android.intent.action.SEND"
}
