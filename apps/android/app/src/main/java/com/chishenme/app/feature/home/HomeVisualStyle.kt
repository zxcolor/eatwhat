package com.chishenme.app.feature.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.chishenme.app.ui.AppDimens
import com.chishenme.app.ui.AppIcons
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
    content()
}

@Composable
internal fun currentHomeVisualColors(): AppVisualPalette = currentAppVisualPalette()

@Composable
internal fun HomeHeroCard() {
    val colors = currentHomeVisualColors()
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HomeDimens.HeroRadius))
            .background(
                Brush.linearGradient(
                    listOf(colors.heroStart, colors.heroEnd),
                ),
            ),
    ) {
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(
                    Brush.radialGradient(
                        colors = listOf(colors.heroGlow.copy(alpha = 0.28f), Color.Transparent),
                        radius = 520f,
                    ),
                ),
        )
        Column(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Surface(
                        color = Color.White.copy(alpha = 0.12f),
                        contentColor = Color.White,
                        shape = CircleShape,
                        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.16f)),
                    ) {
                        Text(
                            "少一点选择，多一点确定",
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                            fontSize = 11.sp,
                            lineHeight = 14.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    Text(
                        "这一顿，\n交给我们来选",
                        modifier = Modifier.semantics { heading() },
                        color = Color.White,
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "从位置和偏好出发，只给真正有用的答案。",
                        color = Color.White.copy(alpha = 0.78f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                HomeFoodArtwork(colors.heroGlow)
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                HomeMetric("30 秒", "完成决定", Modifier.weight(1f))
                HomeMetric("1 + 2", "主推与备选", Modifier.weight(1f))
                HomeMetric("可解释", "推荐理由", Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun HomeFoodArtwork(accent: Color) {
    Box(
        modifier = Modifier.size(84.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(82.dp)
                .border(1.dp, Color.White.copy(alpha = 0.18f), CircleShape),
        )
        Box(
            modifier = Modifier
                .size(62.dp)
                .background(Color.White.copy(alpha = 0.10f), CircleShape)
                .border(1.dp, Color.White.copy(alpha = 0.20f), CircleShape),
        )
        Box(
            modifier = Modifier
                .size(44.dp)
                .background(Color.White, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = AppIcons.Restaurant,
                contentDescription = null,
                tint = accent,
                modifier = Modifier.size(23.dp),
            )
        }
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(13.dp)
                .background(accent, CircleShape)
                .border(2.dp, Color.White.copy(alpha = 0.82f), CircleShape),
        )
        Box(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .size(9.dp)
                .background(Color(0xFFFFD166), CircleShape),
        )
    }
}

@Composable
private fun HomeMetric(value: String, label: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(11.dp))
            .background(Color.White.copy(alpha = 0.10f))
            .border(1.dp, Color.White.copy(alpha = 0.10f), RoundedCornerShape(11.dp))
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        Text(
            value,
            color = Color.White,
            fontSize = 14.sp,
            lineHeight = 18.sp,
            fontWeight = FontWeight.Bold,
        )
        Text(
            label,
            color = Color.White.copy(alpha = 0.78f),
            fontSize = 10.sp,
            lineHeight = 13.sp,
        )
    }
}

@Composable
internal fun HomeCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = currentHomeVisualColors()
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = colors.card),
        shape = RoundedCornerShape(HomeDimens.CardRadius),
        border = BorderStroke(1.dp, colors.border),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(
            modifier = Modifier.padding(HomeDimens.CardPadding),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            content()
        }
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
    val colors = currentHomeVisualColors()
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = HomeDimens.PrimaryButtonHeight),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
            disabledContainerColor = colors.cardMuted,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
        elevation = ButtonDefaults.buttonElevation(
            defaultElevation = 2.dp,
            pressedElevation = 0.dp,
            disabledElevation = 0.dp,
        ),
        shape = RoundedCornerShape(14.dp),
    ) {
        Icon(AppIcons.Restaurant, contentDescription = null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(9.dp))
        Text("帮我决定", fontWeight = FontWeight.Bold)
    }
}
