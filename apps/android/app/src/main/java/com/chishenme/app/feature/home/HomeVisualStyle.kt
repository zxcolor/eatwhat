package com.chishenme.app.feature.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppMotion
import com.chishenme.app.ui.AppVisualPalette
import com.chishenme.app.ui.currentAppVisualPalette

internal object HomeDimens {
    val ScreenHorizontal = AppDimens.ScreenHorizontal
    val SectionGap = AppDimens.SectionGap
    val CardPadding = AppDimens.CardPadding
    val CardRadius = AppDimens.CardRadius
    val CompactRadius = AppDimens.CompactRadius
    val HeroRadius = AppDimens.HeroRadius
    val MinTouchTarget = AppDimens.MinTouchTarget
    val PrimaryButtonHeight = AppDimens.PrimaryButtonHeight
}

internal object HomeMotion {
    const val SelectionMillis = AppMotion.SelectionMillis
}

@Composable
internal fun HomeSurfaceTheme(content: @Composable () -> Unit) {
    val base = MaterialTheme.colorScheme
    val dark = base.background.luminance() < .5f
    MaterialTheme(
        colorScheme = base.copy(
            primary = if (dark) Color(0xFFFFB286) else Color(0xFFC64713),
            onPrimary = if (dark) Color(0xFF49220F) else Color.White,
            primaryContainer = if (dark) Color(0xFF493024) else Color(0xFFFFEADD),
            onPrimaryContainer = if (dark) Color(0xFFFFDAC5) else Color(0xFF753014),
            secondary = if (dark) Color(0xFFD8BDAA) else Color(0xFF79614F),
            background = if (dark) Color(0xFF1D1B19) else Color(0xFFFAF9F6),
            onBackground = if (dark) Color(0xFFF5ECE5) else Color(0xFF222326),
            surface = if (dark) Color(0xFF2B2825) else Color.White,
            onSurface = if (dark) Color(0xFFF5ECE5) else Color(0xFF222326),
            surfaceVariant = if (dark) Color(0xFF383029) else Color(0xFFF1EEEA),
            onSurfaceVariant = if (dark) Color(0xFFC7B8AB) else Color(0xFF746C65),
            outlineVariant = if (dark) Color(0xFF4C443D) else Color(0xFFECE9E4),
        ),
        content = content,
    )
}

@Composable
internal fun currentHomeVisualColors(): AppVisualPalette = currentAppVisualPalette().copy(
    page = MaterialTheme.colorScheme.background,
    card = MaterialTheme.colorScheme.surface,
    cardMuted = MaterialTheme.colorScheme.surfaceVariant,
    border = MaterialTheme.colorScheme.outlineVariant,
    accentSoft = MaterialTheme.colorScheme.primaryContainer,
)

@Composable
internal fun HomeCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = currentHomeVisualColors().card),
        border = BorderStroke(.5.dp, currentHomeVisualColors().border),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
    }
}

@Composable
internal fun HomeIconTile(
    color: Color,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(42.dp)
            .background(color, RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}
