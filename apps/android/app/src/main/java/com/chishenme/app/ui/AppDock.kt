package com.chishenme.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.LayoutDirection

enum class AppTab(val label: String) { HOME("首页"), HISTORY("历史"), PERSONAL("个人") }

@Composable
fun AppDock(selected: AppTab, onSelect: (AppTab) -> Unit) {
    val shape = RoundedCornerShape(50)
    val position by animateFloatAsState(
        targetValue = selected.ordinal.toFloat(),
        animationSpec = tween(AppMotion.SelectionMillis, easing = AppMotion.SelectionEasing),
        label = "Dock selection",
    )
    val direction = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1
    Box(Modifier.navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp)) {
        Surface(
            shape = shape,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(.7.dp, MaterialTheme.colorScheme.outlineVariant),
            modifier = Modifier.testTag("app-dock"),
        ) {
            BoxWithConstraints(Modifier.fillMaxWidth().padding(5.dp)) {
                val itemWidth = maxWidth / AppTab.entries.size
                // Only the shared highlight moves; Dock geometry and hit targets stay fixed.
                // Compose's animator duration scale also handles the system's reduced-motion setting.
                Box(Modifier.matchParentSize()) {
                    Box(
                        Modifier.width(itemWidth).fillMaxHeight()
                            .graphicsLayer { translationX = direction * position * itemWidth.toPx() }
                            .clip(shape).background(MaterialTheme.colorScheme.surfaceVariant)
                            .testTag("dock-indicator"),
                    )
                }
                Row(Modifier.fillMaxWidth().selectableGroup()) {
                    AppTab.entries.forEach { tab ->
                        val active = tab == selected
                        Column(
                            Modifier.weight(1f).clip(shape)
                                .selectable(active, role = Role.Tab, onClick = { onSelect(tab) })
                                .testTag("dock-${tab.name.lowercase()}")
                                .heightIn(min = 62.dp).padding(vertical = 7.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            val color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
                            Icon(
                                when (tab) {
                                    AppTab.HOME -> Icons.Rounded.Home
                                    AppTab.HISTORY -> AppIcons.AccessTime
                                    AppTab.PERSONAL -> Icons.Rounded.Person
                                },
                                contentDescription = null,
                                tint = color,
                                modifier = Modifier.size(28.dp),
                            )
                            Text(tab.label, color = color, style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
            }
        }
    }
}
