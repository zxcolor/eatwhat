package com.chishenme.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties

/** Shared mobile visual language, adapted from the approved HomeScreen direction. */
object AppDimens {
    val ScreenHorizontal = 14.dp
    val ScreenVertical = 12.dp
    val SectionGap = 14.dp
    val CardPadding = 16.dp
    val CardRadius = 14.dp
    val HeroRadius = 20.dp
    val CompactRadius = 10.dp
    val IconTile = 42.dp
    val MinTouchTarget = 48.dp
    val PrimaryButtonHeight = 54.dp
}

object AppMotion {
    const val SelectionMillis = 180
    const val ContentMillis = 260
    const val SheetMillis = 420
}

@Immutable
data class AppVisualPalette(
    val page: Color,
    val card: Color,
    val cardMuted: Color,
    val border: Color,
    val accentSoft: Color,
    val blueSoft: Color,
    val blueStrong: Color,
    val greenSoft: Color,
    val greenStrong: Color,
    val amberSoft: Color,
    val amberStrong: Color,
    val heroStart: Color,
    val heroEnd: Color,
    val heroGlow: Color,
)

private val LightAppVisualPalette = AppVisualPalette(
    page = Color(0xFFF5F6F7),
    card = Color.White,
    cardMuted = Color(0xFFF0F1F4),
    border = Color(0xFFE7E8EC),
    accentSoft = Color(0xFFFDE7F2),
    blueSoft = Color(0xFFEAF0FF),
    blueStrong = Color(0xFF4A68A2),
    greenSoft = Color(0xFFE8F7EF),
    greenStrong = Color(0xFF267653),
    amberSoft = Color(0xFFFFF2D9),
    amberStrong = Color(0xFF98611A),
    heroStart = Color(0xFF282237),
    heroEnd = Color(0xFF7A2858),
    heroGlow = Color(0xFFFF77B7),
)

private val DarkAppVisualPalette = AppVisualPalette(
    page = Color(0xFF292A2D),
    card = Color(0xFF323335),
    cardMuted = Color(0xFF37383A),
    border = Color(0xFF44464B),
    accentSoft = Color(0xFF57213A),
    blueSoft = Color(0xFF29354D),
    blueStrong = Color(0xFFAFC6FF),
    greenSoft = Color(0xFF293E35),
    greenStrong = Color(0xFF8ED8B2),
    amberSoft = Color(0xFF493A24),
    amberStrong = Color(0xFFFFD18B),
    heroStart = Color(0xFF211D2B),
    heroEnd = Color(0xFF63304D),
    heroGlow = Color(0xFFFF77B7),
)

@Composable
fun currentAppVisualPalette(): AppVisualPalette =
    if (MaterialTheme.colorScheme.background.luminance() < 0.5f) {
        DarkAppVisualPalette
    } else {
        LightAppVisualPalette
    }

enum class AppTone { NEUTRAL, ACCENT, INFO, SUCCESS, WARNING, ERROR }

@Composable
private fun AppTone.colors(): Pair<Color, Color> {
    val palette = currentAppVisualPalette()
    return when (this) {
        AppTone.NEUTRAL -> palette.cardMuted to MaterialTheme.colorScheme.onSurfaceVariant
        AppTone.ACCENT -> palette.accentSoft to MaterialTheme.colorScheme.primary
        AppTone.INFO -> palette.blueSoft to palette.blueStrong
        AppTone.SUCCESS -> palette.greenSoft to palette.greenStrong
        AppTone.WARNING -> palette.amberSoft to palette.amberStrong
        AppTone.ERROR -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.error
    }
}

@Composable
fun AppTopBar(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    subtitle: String? = null,
    navigationContentDescription: String = "返回",
    navigationEnabled: Boolean = true,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .statusBarsPadding(),
        color = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            onBack?.let {
                IconButton(onClick = it, enabled = navigationEnabled) {
                    Icon(
                        Icons.AutoMirrored.Rounded.ArrowBack,
                        contentDescription = navigationContentDescription,
                    )
                }
            }
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(start = if (onBack == null) 12.dp else 0.dp, end = 8.dp),
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.semantics { heading() },
                )
                subtitle?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            actions()
        }
    }
}

/** Branded modal surface shared by consent, account, settings, results and safety gates. */
@Composable
fun AppDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    dismissButton: (@Composable () -> Unit)? = null,
    icon: (@Composable () -> Unit)? = null,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
    properties: DialogProperties = DialogProperties(),
) {
    val palette = currentAppVisualPalette()
    val shape = RoundedCornerShape(22.dp)
    val textScrollState = rememberScrollState()
    val textMaxHeight = (LocalConfiguration.current.screenHeightDp.dp * 0.42f)
        .coerceIn(120.dp, 420.dp)
    AlertDialog(
        onDismissRequest = onDismissRequest,
        confirmButton = confirmButton,
        modifier = modifier.border(1.dp, palette.border, shape),
        dismissButton = dismissButton,
        icon = icon,
        title = title,
        text = text?.let { content ->
            {
                Box(
                    modifier = Modifier
                        .heightIn(max = textMaxHeight)
                        .verticalScroll(textScrollState),
                ) {
                    content()
                }
            }
        },
        shape = shape,
        containerColor = palette.card,
        iconContentColor = MaterialTheme.colorScheme.primary,
        titleContentColor = MaterialTheme.colorScheme.onSurface,
        textContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        tonalElevation = 0.dp,
        properties = properties,
    )
}

/** Rounded, high-contrast feedback surface used instead of raw Material snackbars or Toasts. */
@Composable
fun AppSnackbarHost(
    hostState: SnackbarHostState,
    modifier: Modifier = Modifier,
) {
    SnackbarHost(hostState = hostState, modifier = modifier) { data ->
        Snackbar(
            snackbarData = data,
            modifier = Modifier.padding(horizontal = AppDimens.ScreenHorizontal, vertical = 8.dp),
            shape = RoundedCornerShape(AppDimens.CardRadius),
            containerColor = MaterialTheme.colorScheme.inverseSurface,
            contentColor = MaterialTheme.colorScheme.inverseOnSurface,
            actionContentColor = MaterialTheme.colorScheme.inversePrimary,
            dismissActionContentColor = MaterialTheme.colorScheme.inverseOnSurface,
        )
    }
}

@Composable
fun AppHeroCard(
    title: String,
    description: String,
    modifier: Modifier = Modifier,
    eyebrow: String? = null,
    icon: ImageVector = AppIcons.Restaurant,
    footer: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val palette = currentAppVisualPalette()
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(AppDimens.HeroRadius))
            .background(Brush.linearGradient(listOf(palette.heroStart, palette.heroEnd))),
    ) {
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(
                    Brush.radialGradient(
                        colors = listOf(palette.heroGlow.copy(alpha = 0.28f), Color.Transparent),
                        radius = 560f,
                    ),
                ),
        )
        Column(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    eyebrow?.let {
                        Surface(
                            color = Color.White.copy(alpha = 0.12f),
                            contentColor = Color.White,
                            shape = CircleShape,
                            border = BorderStroke(1.dp, Color.White.copy(alpha = 0.14f)),
                        ) {
                            Text(
                                text = it,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                    Text(
                        text = title,
                        modifier = Modifier.semantics { heading() },
                        color = Color.White,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = description,
                        color = Color.White.copy(alpha = 0.76f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Box(modifier = Modifier.size(72.dp), contentAlignment = Alignment.Center) {
                    Box(
                        modifier = Modifier
                            .size(70.dp)
                            .border(1.dp, Color.White.copy(alpha = 0.17f), CircleShape),
                    )
                    Surface(
                        modifier = Modifier.size(48.dp),
                        shape = CircleShape,
                        color = Color.White.copy(alpha = 0.13f),
                        contentColor = Color.White,
                        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.18f)),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(icon, contentDescription = null, modifier = Modifier.size(25.dp))
                        }
                    }
                }
            }
            footer?.invoke(this)
        }
    }
}

@Composable
fun AppCard(
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(AppDimens.CardPadding),
    containerColor: Color = currentAppVisualPalette().card,
    content: @Composable ColumnScope.() -> Unit,
) {
    val palette = currentAppVisualPalette()
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = containerColor),
        shape = RoundedCornerShape(AppDimens.CardRadius),
        border = BorderStroke(1.dp, palette.border),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(
            modifier = Modifier
                .animateContentSize(tween(AppMotion.ContentMillis))
                .padding(contentPadding),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            content = content,
        )
    }
}

@Composable
fun AppSectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = title,
                modifier = Modifier.semantics { heading() },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            subtitle?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        trailing?.invoke()
    }
}

@Composable
fun AppIconTile(
    icon: ImageVector,
    modifier: Modifier = Modifier,
    tone: AppTone = AppTone.ACCENT,
    contentDescription: String? = null,
    size: Dp = AppDimens.IconTile,
) {
    val (background, foreground) = tone.colors()
    Box(
        modifier = modifier
            .size(size)
            .background(background, RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = foreground,
            modifier = Modifier.size(21.dp),
        )
    }
}

@Composable
fun AppStatusBanner(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    tone: AppTone = AppTone.NEUTRAL,
    icon: ImageVector? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val (targetBackground, targetForeground) = tone.colors()
    val background = animateColorAsState(
        targetValue = targetBackground,
        animationSpec = tween(AppMotion.SelectionMillis),
        label = "status-background",
    ).value
    val foreground = animateColorAsState(
        targetValue = targetForeground,
        animationSpec = tween(AppMotion.SelectionMillis),
        label = "status-foreground",
    ).value
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(background, RoundedCornerShape(AppDimens.CompactRadius))
            .border(1.dp, foreground.copy(alpha = 0.14f), RoundedCornerShape(AppDimens.CompactRadius))
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon?.let {
            Icon(it, contentDescription = null, tint = foreground, modifier = Modifier.size(21.dp))
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(
                body,
                style = MaterialTheme.typography.bodySmall,
                color = foreground,
            )
        }
        action?.invoke()
    }
}

@Composable
fun AppBadge(
    text: String,
    modifier: Modifier = Modifier,
    tone: AppTone = AppTone.ACCENT,
) {
    val (targetBackground, targetForeground) = tone.colors()
    val background = animateColorAsState(
        targetValue = targetBackground,
        animationSpec = tween(AppMotion.SelectionMillis),
        label = "badge-background",
    ).value
    val foreground = animateColorAsState(
        targetValue = targetForeground,
        animationSpec = tween(AppMotion.SelectionMillis),
        label = "badge-foreground",
    ).value
    Surface(
        modifier = modifier,
        color = background,
        contentColor = foreground,
        shape = CircleShape,
        border = BorderStroke(1.dp, foreground.copy(alpha = 0.12f)),
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
fun AppPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    content: (@Composable RowScope.() -> Unit)? = null,
) {
    val palette = currentAppVisualPalette()
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = AppDimens.PrimaryButtonHeight),
        shape = RoundedCornerShape(AppDimens.CardRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
            disabledContainerColor = palette.cardMuted,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
        elevation = ButtonDefaults.buttonElevation(
            defaultElevation = 2.dp,
            pressedElevation = 0.dp,
            disabledElevation = 0.dp,
        ),
    ) {
        if (content != null) {
            content()
        } else {
            icon?.let {
                Icon(it, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(9.dp))
            }
            Text(text, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
fun AppEmptyState(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    icon: ImageVector = AppIcons.Restaurant,
    action: (@Composable () -> Unit)? = null,
) {
    AppCard(modifier = modifier) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AppIconTile(icon = icon, tone = AppTone.ACCENT, size = 48.dp)
            Text(
                title,
                modifier = Modifier.semantics { heading() },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(
                body,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            action?.invoke()
        }
    }
}

@Composable
fun AppLaunchLoading(modifier: Modifier = Modifier) {
    val palette = currentAppVisualPalette()
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(palette.page),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(modifier = Modifier.size(78.dp), contentAlignment = Alignment.Center) {
                Box(
                    modifier = Modifier
                        .size(76.dp)
                        .background(
                            Brush.linearGradient(listOf(palette.heroStart, palette.heroEnd)),
                            CircleShape,
                        ),
                )
                Surface(
                    modifier = Modifier.size(48.dp),
                    shape = CircleShape,
                    color = Color.White.copy(alpha = 0.94f),
                    contentColor = MaterialTheme.colorScheme.primary,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            AppIcons.Restaurant,
                            contentDescription = null,
                            modifier = Modifier.size(25.dp),
                        )
                    }
                }
            }
            Text("吃什么", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(
                "正在准备这一顿…",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            CircularProgressIndicator(
                modifier = Modifier.size(22.dp),
                strokeWidth = 2.dp,
            )
        }
    }
}
