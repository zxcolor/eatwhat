package com.chishenme.app.feature.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The approved homepage: one decision action and an explicit location entry. */
@Composable
internal fun HomeLanding(
    locationLabel: String?,
    locationDescription: String,
    decisionEnabled: Boolean,
    showNotice: Boolean,
    onLocation: () -> Unit,
    onDecide: () -> Unit,
    modifier: Modifier = Modifier,
    notice: @Composable () -> Unit = {},
) {
    val colors = currentHomeVisualColors()
    BoxWithConstraints(modifier.fillMaxSize().background(colors.page).testTag("home-screen")) {
        val compact = maxHeight < 500.dp || LocalDensity.current.fontScale > 1.3f
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp, vertical = if (compact) 16.dp else 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "今天中午吃什么",
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = 32.sp, lineHeight = 40.sp),
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.semantics { heading() },
            )
            HomeLocation(locationLabel, locationDescription, onLocation)
            if (showNotice) notice()
            Spacer(Modifier.height(if (compact) 0.dp else 8.dp))
            HomeDecisionCard(decisionEnabled, onDecide)
        }
    }
}

@Composable
private fun HomeLocation(label: String?, description: String, onClick: () -> Unit) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        onClick = onClick,
        color = Color.Transparent,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("home-location").semantics {
            contentDescription = "选择位置"
            stateDescription = description
        },
    ) {
        Row(
            Modifier.padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Canvas(Modifier.size(20.dp)) {
                drawPath(Path().apply {
                    moveTo(size.width * .88f, size.height * .12f)
                    lineTo(size.width * .61f, size.height * .91f)
                    lineTo(size.width * .44f, size.height * .58f)
                    lineTo(size.width * .1f, size.height * .42f)
                    close()
                }, color)
            }
            Text(
                label ?: "当前位置",
                modifier = Modifier.weight(1f, fill = false),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = color,
                style = MaterialTheme.typography.titleLarge,
            )
            Canvas(Modifier.size(12.dp)) {
                drawLine(color, Offset(1f, size.height * .35f), Offset(size.width * .5f, size.height * .72f), 1.7.dp.toPx(), StrokeCap.Round)
                drawLine(color, Offset(size.width * .5f, size.height * .72f), Offset(size.width - 1f, size.height * .35f), 1.7.dp.toPx(), StrokeCap.Round)
            }
        }
    }
}

@Composable
private fun HomeDecisionCard(enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(28.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().testTag("home-decide"),
    ) {
        Column(
            Modifier.fillMaxWidth().heightIn(min = 188.dp).padding(horizontal = 24.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            DecisionDice(Modifier.size(56.dp))
            Text(
                "帮我选",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else .5f),
            )
            Text("What to eat？", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

/** Small native dice illustration; no remote asset or image request on launch. */
@Composable
private fun DecisionDice(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        fun point(x: Float, y: Float) = Offset(size.width * x, size.height * y)
        fun face(first: Offset, second: Offset, third: Offset, fourth: Offset) = Path().apply {
            moveTo(first.x, first.y)
            listOf(second, third, fourth).forEach { lineTo(it.x, it.y) }
            close()
        }
        val top = point(.5f, .08f)
        val left = point(.12f, .24f)
        val middle = point(.5f, .43f)
        val right = point(.88f, .24f)
        val bottom = point(.5f, .95f)
        drawPath(face(top, right, middle, left), Brush.linearGradient(listOf(Color(0xFFF3F3F3), Color(0xFFDADADA))))
        drawPath(face(left, middle, bottom, point(.14f, .73f)), Brush.linearGradient(listOf(Color(0xFFD8D8D8), Color(0xFFBDBDBD))))
        drawPath(face(middle, right, point(.86f, .73f), bottom), Brush.linearGradient(listOf(Color(0xFFBEBEBE), Color(0xFF919191))))
        drawOval(Color(0xFFE13C3C), point(.43f, .21f), Size(size.width * .14f, size.height * .06f))
        listOf(point(.27f, .46f), point(.32f, .72f), point(.7f, .43f), point(.68f, .62f), point(.66f, .8f)).forEach {
            drawOval(Color(0xFF222222), it - point(.04f, .055f), Size(size.width * .08f, size.height * .11f))
        }
    }
}
