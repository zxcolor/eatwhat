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

private val BrandRaspberry = Color(0xFFC02A6D)
private val BrandRaspberryDark = Color(0xFFFF82B7)
private val PageLight = Color(0xFFF5F6F7)
private val PageDark = Color(0xFF292A2D)
private val Ink = Color(0xFF25262A)

private val LightColors = lightColorScheme(
    primary = BrandRaspberry,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFDE7F2),
    onPrimaryContainer = Color(0xFF4B102C),
    inversePrimary = Color(0xFFFFA7CD),
    secondary = Color(0xFF4A68A2),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEAF0FF),
    onSecondaryContainer = Color(0xFF19325C),
    tertiary = Color(0xFF2C7A55),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFE8F7EF),
    onTertiaryContainer = Color(0xFF174C34),
    background = PageLight,
    onBackground = Ink,
    surface = Color.White,
    onSurface = Ink,
    surfaceVariant = Color(0xFFF0F1F4),
    onSurfaceVariant = Color(0xFF666A72),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFAFAFB),
    surfaceContainer = Color(0xFFF5F6F8),
    surfaceContainerHigh = Color(0xFFF0F1F4),
    surfaceContainerHighest = Color(0xFFE9EAEE),
    outline = Color(0xFF858A93),
    outlineVariant = Color(0xFFE7E8EC),
    inverseSurface = Color(0xFF303136),
    inverseOnSurface = Color(0xFFF5F6F7),
    error = Color(0xFFB3261E),
    errorContainer = Color(0xFFFFE9E7),
    onErrorContainer = Color(0xFF5C1110),
)

private val DarkColors = darkColorScheme(
    primary = BrandRaspberryDark,
    onPrimary = Color(0xFF4A0B27),
    primaryContainer = Color(0xFF57213A),
    onPrimaryContainer = Color(0xFFFFD9E9),
    inversePrimary = BrandRaspberry,
    secondary = Color(0xFFAFC6FF),
    onSecondary = Color(0xFF14284E),
    secondaryContainer = Color(0xFF29354D),
    onSecondaryContainer = Color(0xFFDCE6FF),
    tertiary = Color(0xFF8ED8B2),
    onTertiary = Color(0xFF113B29),
    tertiaryContainer = Color(0xFF293E35),
    onTertiaryContainer = Color(0xFFC8F3DC),
    background = PageDark,
    onBackground = Color(0xFFF8FAFC),
    surface = Color(0xFF323335),
    onSurface = Color(0xFFF8FAFC),
    surfaceVariant = Color(0xFF37383A),
    onSurfaceVariant = Color(0xFFB8BBC2),
    surfaceContainerLowest = Color(0xFF27282B),
    surfaceContainerLow = Color(0xFF2D2E31),
    surfaceContainer = Color(0xFF323335),
    surfaceContainerHigh = Color(0xFF37383A),
    surfaceContainerHighest = Color(0xFF3D3E42),
    outline = Color(0xFF7E8189),
    outlineVariant = Color(0xFF44464B),
    inverseSurface = Color(0xFFF1F2F4),
    inverseOnSurface = Color(0xFF2B2C30),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF5B2423),
    onErrorContainer = Color(0xFFFFDAD6),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
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
