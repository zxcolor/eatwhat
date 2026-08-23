package com.chishenme.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.chishenme.app.data.local.ThemePreference

private val Orange = Color(0xFFF36B2B)
private val OrangeDark = Color(0xFFFFB690)
private val Cream = Color(0xFFFFF8F0)
private val Ink = Color(0xFF2D201A)
private val Sage = Color(0xFF4E7157)

private val LightColors = lightColorScheme(
    primary = Orange,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDBCA),
    onPrimaryContainer = Color(0xFF351000),
    secondary = Sage,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFD1E8D4),
    background = Cream,
    onBackground = Ink,
    surface = Color(0xFFFFFBF7),
    onSurface = Ink,
    surfaceVariant = Color(0xFFF3E7DF),
    outline = Color(0xFF8D7466),
    error = Color(0xFFBA1A1A),
)

private val DarkColors = darkColorScheme(
    primary = OrangeDark,
    onPrimary = Color(0xFF552000),
    primaryContainer = Color(0xFF793100),
    onPrimaryContainer = Color(0xFFFFDBCA),
    secondary = Color(0xFFB5CCB8),
    onSecondary = Color(0xFF203526),
    background = Color(0xFF17120F),
    onBackground = Color(0xFFF0E0D7),
    surface = Color(0xFF201A17),
    onSurface = Color(0xFFF0E0D7),
    surfaceVariant = Color(0xFF51443D),
    outline = Color(0xFFD4B9AA),
    error = Color(0xFFFFB4AB),
)

@Composable
fun ChiShenMeTheme(
    themePreference: ThemePreference,
    content: @Composable () -> Unit,
) {
    val darkTheme = when (themePreference) {
        ThemePreference.SYSTEM -> isSystemInDarkTheme()
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
    }
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = AppTypography,
        content = content,
    )
}
