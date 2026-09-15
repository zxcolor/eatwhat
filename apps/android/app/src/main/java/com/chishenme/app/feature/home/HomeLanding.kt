package com.chishenme.app.feature.home

import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.geometry.Size
import com.chishenme.app.R
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.ui.AppIcons
import kotlin.math.cos
import kotlin.math.sin

/** Home-only visual surface. Controls remain real native, accessible controls. */
@Composable
internal fun HomeLanding(
    meal: MealPeriod,
    availableMeals: Set<MealPeriod>,
    locationLabel: String?,
    locationDescription: String,
    conditionsDescription: String,
    decisionEnabled: Boolean,
    showNotice: Boolean,
    onMeal: (MealPeriod) -> Unit,
    onLocation: () -> Unit,
    onConditions: () -> Unit,
    onDecide: () -> Unit,
    modifier: Modifier = Modifier,
    notice: @Composable () -> Unit = {},
) {
    val colors = currentHomeVisualColors()
    BoxWithConstraints(modifier.fillMaxSize().background(colors.page).testTag("home-screen")) {
        val compact = maxHeight < 560.dp || maxWidth < 330.dp || LocalDensity.current.fontScale > 1.3f || showNotice
        val meals: @Composable () -> Unit = { HomeMealPicker(meal, availableMeals, onMeal) }
        val food: @Composable () -> Unit = { HomeFoodButton(meal, decisionEnabled, onDecide) }
        val utilities: @Composable () -> Unit = {
            HomeUtilities(locationLabel, locationDescription, conditionsDescription, onLocation, onConditions)
        }
        if (compact) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(28.dp),
            ) {
                meals()
                notice()
                food()
                utilities()
            }
        } else {
            Box(Modifier.align(Alignment.TopCenter).padding(top = maxHeight * .20f).padding(horizontal = 20.dp)) { meals() }
            Box(Modifier.align(Alignment.Center)) { food() }
            Box(Modifier.align(Alignment.BottomCenter).padding(horizontal = 20.dp, vertical = 44.dp)) { utilities() }
        }
    }
}

@Composable
internal fun HomeMealPicker(selected: MealPeriod, available: Set<MealPeriod>, onSelect: (MealPeriod) -> Unit) {
    val colors = currentHomeVisualColors()
    val shape = RoundedCornerShape(50)
    Row(
        Modifier.widthIn(max = 420.dp).fillMaxWidth().shadow(8.dp, shape, ambientColor = Color.Black.copy(alpha = .06f), spotColor = Color.Black.copy(alpha = .06f))
            .background(Brush.verticalGradient(listOf(colors.card, colors.card.copy(alpha = .48f))), shape)
            .border(.7.dp, colors.border.copy(alpha = .65f), shape).padding(3.dp).selectableGroup(),
    ) {
        MealPeriod.entries.forEach { meal ->
            val enabled = meal in available
            val chosen = selected == meal
            val fill by animateColorAsState(if (chosen) colors.card else Color.Transparent, tween(180), label = "meal fill")
            val foreground = when {
                !enabled -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .55f)
                chosen -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.onSurface
            }
            Row(
                Modifier.weight(1f).clip(shape).background(fill)
                    .selectable(chosen, enabled = enabled, role = Role.RadioButton, onClick = { onSelect(meal) })
                    .testTag("meal-${meal.name.lowercase()}")
                    .semantics { if (!enabled) stateDescription = "当前服务暂未开放" }
                    .heightIn(min = 50.dp).padding(horizontal = 6.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
            ) {
                if (LocalDensity.current.fontScale <= 1.3f) MealSymbol(meal, foreground)
                Text(mealLabel(meal), color = foreground, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

internal fun mealLabel(meal: MealPeriod): String = when (meal) {
    MealPeriod.BREAKFAST -> "早餐"
    MealPeriod.LUNCH -> "午餐"
    MealPeriod.DINNER -> "晚餐"
}

@Composable
private fun MealSymbol(meal: MealPeriod, color: Color) {
    Canvas(Modifier.size(24.dp)) {
        val unit = size.width / 24f
        val stroke = 1.65f * unit
        if (meal == MealPeriod.DINNER) {
            val moon = Path().apply {
                moveTo(16f * unit, 3f * unit)
                cubicTo(3f * unit, 1f * unit, 1f * unit, 19f * unit, 13f * unit, 21f * unit)
                cubicTo(18f * unit, 22f * unit, 22f * unit, 17f * unit, 21f * unit, 13f * unit)
                cubicTo(13f * unit, 18f * unit, 9f * unit, 8f * unit, 16f * unit, 3f * unit)
                close()
            }
            drawPath(moon, color, style = Stroke(stroke, cap = StrokeCap.Round))
        } else {
            val center = Offset(12f * unit, 12f * unit)
            drawCircle(color, 4.5f * unit, center, style = if (meal == MealPeriod.BREAKFAST) Stroke(stroke) else androidx.compose.ui.graphics.drawscope.Fill)
            for (i in 0..7) {
                val angle = i * Math.PI / 4
                val direction = Offset(cos(angle).toFloat(), sin(angle).toFloat())
                drawLine(color, center + direction * (8f * unit), center + direction * (10.5f * unit), stroke, StrokeCap.Round)
            }
        }
    }
}

@Composable
internal fun HomeFoodButton(meal: MealPeriod, enabled: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) .965f else 1f, spring(dampingRatio = .65f, stiffness = 450f), label = "food press")
    val dark = MaterialTheme.colorScheme.background.luminance() < .5f
    val largeText = LocalDensity.current.fontScale > 1.3f
    Box(
        Modifier.widthIn(max = if (largeText) 310.dp else 252.dp).fillMaxWidth()
            .drawBehind {
                drawCircle(Brush.radialGradient(listOf(Color(0xFFF1D5AB).copy(alpha = if (dark) .10f else .20f), Color.Transparent), center, size.width * .78f), radius = size.width * .78f)
            }
            .scale(scale).clip(RoundedCornerShape(38.dp))
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .testTag("home-decide").semantics { stateDescription = mealLabel(meal) }
            .heightIn(min = 104.dp),
        contentAlignment = Alignment.Center,
    ) {
        Crossfade(targetState = meal, animationSpec = tween(220), label = "meal food") { currentMeal ->
            val drawable = when (currentMeal) {
                MealPeriod.BREAKFAST -> R.drawable.home_food_bread
                MealPeriod.LUNCH -> R.drawable.home_food_omelette
                MealPeriod.DINNER -> R.drawable.home_food_dumpling
            }
            val silhouette = remember(currentMeal) { FoodSilhouette(currentMeal) }
            Image(
                painterResource(drawable), contentDescription = null,
                modifier = Modifier.fillMaxWidth().aspectRatio(2f)
                    .shadow(5.dp, silhouette, clip = false).clip(silhouette),
                contentScale = ContentScale.Fit, alpha = if (enabled) 1f else .55f,
            )
        }
        Text(
            "现在决定",
            color = if (meal == MealPeriod.BREAKFAST) Color.White else Color(0xFF392315),
            fontSize = 21.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .5.sp,
            style = MaterialTheme.typography.titleLarge.copy(shadow = if (meal == MealPeriod.BREAKFAST) Shadow(Color(0x99512310), Offset(0f, 1f), 2f) else null),
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
        )
    }
}

/** Native silhouettes keep the generated asset matte out of light and dark backgrounds. */
private class FoodSilhouette(private val meal: MealPeriod) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val path = Path()
        fun move(x: Float, y: Float) = path.moveTo(x * size.width, y * size.height)
        fun curve(x1: Float, y1: Float, x2: Float, y2: Float, x3: Float, y3: Float) =
            path.cubicTo(x1 * size.width, y1 * size.height, x2 * size.width, y2 * size.height, x3 * size.width, y3 * size.height)
        when (meal) {
            MealPeriod.BREAKFAST -> {
                move(.245f, .198f)
                curve(.105f, .197f, .053f, .291f, .052f, .497f)
                curve(.055f, .661f, .095f, .761f, .204f, .763f)
                curve(.39f, .764f, .76f, .764f, .808f, .763f)
                curve(.921f, .756f, .949f, .627f, .949f, .495f)
                curve(.949f, .299f, .903f, .198f, .798f, .198f)
                curve(.65f, .198f, .39f, .198f, .245f, .198f)
            }
            MealPeriod.LUNCH -> {
                move(.501f, .151f)
                curve(.297f, .151f, .115f, .289f, .067f, .445f)
                curve(.023f, .505f, .046f, .575f, .070f, .620f)
                curve(.097f, .778f, .291f, .895f, .511f, .899f)
                curve(.759f, .897f, .877f, .792f, .933f, .624f)
                curve(.977f, .561f, .965f, .509f, .941f, .459f)
                curve(.866f, .267f, .690f, .151f, .501f, .151f)
            }
            MealPeriod.DINNER -> {
                move(.082f, .357f)
                curve(.090f, .299f, .140f, .375f, .188f, .348f)
                curve(.247f, .287f, .259f, .232f, .328f, .234f)
                curve(.365f, .232f, .398f, .184f, .442f, .216f)
                curve(.475f, .206f, .489f, .164f, .521f, .201f)
                curve(.550f, .238f, .570f, .184f, .608f, .220f)
                curve(.639f, .253f, .656f, .216f, .691f, .249f)
                curve(.741f, .278f, .776f, .369f, .831f, .356f)
                curve(.868f, .343f, .913f, .300f, .921f, .357f)
                curve(.919f, .428f, .867f, .624f, .824f, .735f)
                curve(.765f, .852f, .661f, .832f, .494f, .834f)
                curve(.321f, .833f, .223f, .831f, .177f, .727f)
                curve(.144f, .636f, .073f, .418f, .082f, .357f)
            }
        }
        path.close()
        return Outline.Generic(path)
    }
}

@Composable
private fun HomeUtilities(label: String?, locationDescription: String, conditionsDescription: String, onLocation: () -> Unit, onConditions: () -> Unit) {
    val colors = currentHomeVisualColors()
    Row(Modifier.widthIn(max = 360.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Surface(
            onClick = onLocation,
            modifier = Modifier.weight(1f, fill = false).heightIn(min = 50.dp).testTag("home-location").semantics {
                contentDescription = "选择位置"
                stateDescription = locationDescription
            },
            shape = CircleShape, color = colors.card, border = BorderStroke(.7.dp, colors.border.copy(alpha = .55f)), shadowElevation = 1.dp,
        ) {
            Row(Modifier.padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                Canvas(Modifier.size(21.dp)) {
                    val path = Path().apply { moveTo(size.width * .88f, size.height * .12f); lineTo(size.width * .61f, size.height * .91f); lineTo(size.width * .44f, size.height * .58f); lineTo(size.width * .1f, size.height * .42f); close() }
                    drawPath(path, Color(0xFF1684FF))
                }
                Text(label ?: "当前位置", Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                Canvas(Modifier.size(12.dp)) {
                    val c = colors.blueStrong
                    drawLine(c, Offset(1f, size.height * .35f), Offset(size.width * .5f, size.height * .72f), 1.7.dp.toPx(), StrokeCap.Round)
                    drawLine(c, Offset(size.width * .5f, size.height * .72f), Offset(size.width - 1f, size.height * .35f), 1.7.dp.toPx(), StrokeCap.Round)
                }
            }
        }
        Surface(
            onClick = onConditions,
            modifier = Modifier.size(50.dp).testTag("home-conditions").semantics {
                contentDescription = "调整条件"
                stateDescription = conditionsDescription
            },
            shape = CircleShape, color = colors.card, border = BorderStroke(.7.dp, colors.border.copy(alpha = .55f)), shadowElevation = 1.dp,
        ) { Box(contentAlignment = Alignment.Center) { Icon(AppIcons.Tune, null, Modifier.size(25.dp)) } }
    }
}
