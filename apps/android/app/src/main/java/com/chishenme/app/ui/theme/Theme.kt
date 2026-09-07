package com.chishenme.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import com.chishenme.app.data.local.ThemePreference

private val BrandBlue = Color(0xFF315BCB)
private val BrandBlueDark = Color(0xFFA8C2FF)
private val PageLight = Color(0xFFF5F7FB)
private val PageDark = Color(0xFF141B27)
private val Ink = Color(0xFF1B263B)

private val LightColors = lightColorScheme(
    primary = BrandBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEAF0FF),
    onPrimaryContainer = Color(0xFF17376F),
    inversePrimary = BrandBlueDark,
    secondary = Color(0xFF52688F),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDF2FA),
    onSecondaryContainer = Color(0xFF19325C),
    tertiary = Color(0xFF2C7A55),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFE8F7EF),
    onTertiaryContainer = Color(0xFF174C34),
    background = PageLight,
    onBackground = Ink,
    surface = Color.White,
    onSurface = Ink,
    surfaceVariant = Color(0xFFEEF2F8),
    onSurfaceVariant = Color(0xFF5D6980),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFAFBFD),
    surfaceContainer = Color(0xFFF4F6FA),
    surfaceContainerHigh = Color(0xFFEEF2F8),
    surfaceContainerHighest = Color(0xFFE6ECF5),
    outline = Color(0xFF7A879D),
    outlineVariant = Color(0xFFE3E9F2),
    inverseSurface = Color(0xFF243149),
    inverseOnSurface = Color(0xFFF5F7FB),
    error = Color(0xFFB3261E),
    errorContainer = Color(0xFFFFE9E7),
    onErrorContainer = Color(0xFF5C1110),
)

private val DarkColors = darkColorScheme(
    primary = BrandBlueDark,
    onPrimary = Color(0xFF142C62),
    primaryContainer = Color(0xFF293E66),
    onPrimaryContainer = Color(0xFFDEE8FF),
    inversePrimary = BrandBlue,
    secondary = Color(0xFFAFC6FF),
    onSecondary = Color(0xFF14284E),
    secondaryContainer = Color(0xFF2A374C),
    onSecondaryContainer = Color(0xFFDCE6FF),
    tertiary = Color(0xFF8ED8B2),
    onTertiary = Color(0xFF113B29),
    tertiaryContainer = Color(0xFF293E35),
    onTertiaryContainer = Color(0xFFC8F3DC),
    background = PageDark,
    onBackground = Color(0xFFF8FAFC),
    surface = Color(0xFF1D2736),
    onSurface = Color(0xFFF8FAFC),
    surfaceVariant = Color(0xFF263245),
    onSurfaceVariant = Color(0xFFB7C3D8),
    surfaceContainerLowest = Color(0xFF111823),
    surfaceContainerLow = Color(0xFF192230),
    surfaceContainer = Color(0xFF1D2736),
    surfaceContainerHigh = Color(0xFF263245),
    surfaceContainerHighest = Color(0xFF2D3B50),
    outline = Color(0xFF8292AD),
    outlineVariant = Color(0xFF334157),
    inverseSurface = Color(0xFFF1F2F4),
    inverseOnSurface = Color(0xFF2B2C30),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF5B2423),
    onErrorContainer = Color(0xFFFFDAD6),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp),
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
        shapes = AppShapes,
        content = content,
    )
}
