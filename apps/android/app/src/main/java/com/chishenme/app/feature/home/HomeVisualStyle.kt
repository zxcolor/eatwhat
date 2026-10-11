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
            primary = if (dark) Color(0xFF8BC1FF) else Color(0xFF087AF0),
            onPrimary = if (dark) Color(0xFF092D53) else Color.White,
            primaryContainer = if (dark) Color(0xFF24364F) else Color(0xFFE8F1FD),
            onPrimaryContainer = if (dark) Color(0xFFD5E8FF) else Color(0xFF174A83),
            secondary = if (dark) Color(0xFFBDC5D2) else Color(0xFF626876),
            background = if (dark) Color(0xFF181A20) else Color(0xFFF3F3F8),
            onBackground = if (dark) Color(0xFFF2F3F7) else Color(0xFF16171B),
            surface = if (dark) Color(0xFF242730) else Color.White,
            onSurface = if (dark) Color(0xFFF2F3F7) else Color(0xFF16171B),
            surfaceVariant = if (dark) Color(0xFF303541) else Color(0xFFEBEDF3),
            onSurfaceVariant = if (dark) Color(0xFFBAC2CF) else Color(0xFF737783),
            outlineVariant = if (dark) Color(0xFF454A56) else Color(0xFFDDDFE7),
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
