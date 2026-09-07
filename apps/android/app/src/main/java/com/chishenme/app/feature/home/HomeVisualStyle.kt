package com.chishenme.app.feature.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppCard
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppMotion
import com.chishenme.app.ui.AppPrimaryButton
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
    content()
}

@Composable
internal fun currentHomeVisualColors(): AppVisualPalette = currentAppVisualPalette()

@Composable
internal fun HomeHeroCard() {
    val colors = currentHomeVisualColors()
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HomeDimens.HeroRadius))
            .background(
                Brush.linearGradient(
                    listOf(colors.heroStart, colors.heroEnd),
                ),
            ),
    ) {
        val showArtwork = maxWidth >= 350.dp && LocalDensity.current.fontScale <= 1.15f
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(
                    Brush.radialGradient(
                        colors = listOf(colors.heroGlow.copy(alpha = 0.14f), Color.Transparent),
                        radius = 520f,
                    ),
                ),
        )
        Row(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "少一点选择，多一点确定",
                    color = Color.White.copy(alpha = 0.94f),
                    style = MaterialTheme.typography.labelMedium,
                )
                Text(
                    "这一顿，\n交给我们来选",
                    modifier = Modifier.semantics { heading() },
                    color = Color.White,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "从位置和条件出发，收窄附近选择。",
                    color = Color.White.copy(alpha = 0.94f),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (showArtwork) {
                HomeFoodArtwork(colors.heroGlow)
            }
        }
    }
}

@Composable
private fun HomeFoodArtwork(accent: Color) {
    Canvas(Modifier.size(88.dp).clearAndSetSemantics {}) {
        val w = size.width
        val h = size.height
        drawOval(
            color = accent.copy(alpha = 0.18f),
            topLeft = Offset(0.02f * w, 0.72f * h),
            size = Size(0.96f * w, 0.2f * h),
        )
        drawLine(Color.White.copy(alpha = 0.85f), Offset(0.73f * w, 0.09f * h), Offset(0.43f * w, 0.54f * h), 2.5.dp.toPx(), StrokeCap.Round)
        drawLine(Color.White.copy(alpha = 0.65f), Offset(0.84f * w, 0.13f * h), Offset(0.51f * w, 0.56f * h), 2.5.dp.toPx(), StrokeCap.Round)
        val bowl = Path().apply {
            moveTo(0.1f * w, 0.45f * h)
            cubicTo(0.18f * w, 0.88f * h, 0.82f * w, 0.88f * h, 0.9f * w, 0.45f * h)
            close()
        }
        drawPath(bowl, Brush.verticalGradient(listOf(Color.White, Color(0xFFD9E7FF))))
        drawOval(Color.White, Offset(0.1f * w, 0.34f * h), Size(0.8f * w, 0.22f * h))
        drawOval(Color(0xFFE5EDFA), Offset(0.16f * w, 0.38f * h), Size(0.68f * w, 0.14f * h))
        drawOval(Color(0xFF82CCA8), Offset(0.21f * w, 0.36f * h), Size(0.27f * w, 0.13f * h))
        drawOval(Color(0xFFF5C66C), Offset(0.53f * w, 0.37f * h), Size(0.23f * w, 0.12f * h))
        drawLine(Color(0xFFADC8EE), Offset(0.33f * w, 0.68f * h), Offset(0.67f * w, 0.68f * h), 1.5.dp.toPx(), StrokeCap.Round)
    }
}

@Composable
internal fun HomeCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    AppCard(modifier = modifier) {
        content()
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

@Composable
internal fun HomePrimaryAction(
    enabled: Boolean,
    onClick: () -> Unit,
) {
    AppPrimaryButton(
        text = "帮我决定",
        onClick = onClick,
        enabled = enabled,
        icon = AppIcons.Restaurant,
    )
}
