package com.chishenme.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val AppTypography = Typography(
    displaySmall = appTextStyle(34, 43, FontWeight.Bold, -0.3f),
    headlineLarge = appTextStyle(30, 39, FontWeight.Bold, -0.2f),
    headlineMedium = appTextStyle(26, 34, FontWeight.Bold, -0.1f),
    headlineSmall = appTextStyle(22, 30, FontWeight.Bold),
    titleLarge = appTextStyle(20, 27, FontWeight.SemiBold, -0.1f),
    titleMedium = appTextStyle(16, 24, FontWeight.SemiBold),
    titleSmall = appTextStyle(15, 21, FontWeight.SemiBold),
    bodyLarge = appTextStyle(16, 25, FontWeight.Normal),
    bodyMedium = appTextStyle(14, 22, FontWeight.Normal),
    bodySmall = appTextStyle(12, 18, FontWeight.Normal, 0.1f),
    labelLarge = appTextStyle(14, 20, FontWeight.SemiBold, 0.1f),
    labelMedium = appTextStyle(12, 17, FontWeight.SemiBold, 0.15f),
    labelSmall = appTextStyle(11, 15, FontWeight.Medium, 0.2f),
)

private fun appTextStyle(
    size: Int,
    height: Int,
    weight: FontWeight,
    tracking: Float = 0f,
) = TextStyle(
    fontFamily = FontFamily.SansSerif,
    fontSize = size.sp,
    lineHeight = height.sp,
    fontWeight = weight,
    letterSpacing = tracking.sp,
)
