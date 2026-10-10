package com.chishenme.app.feature.account

internal fun sessionPlatformLabel(platform: String): String = when (platform) {
    "ANDROID" -> "Android"
    "MINIPROGRAM" -> "微信小程序"
    else -> "未知平台"
}
