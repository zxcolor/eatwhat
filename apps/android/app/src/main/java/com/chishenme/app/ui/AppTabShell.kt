package com.chishenme.app.ui

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.chishenme.app.feature.home.HomeSurfaceTheme

/** A single Dock survives all top-level destination changes. */
@Composable
internal fun AppTabShell(
    selected: AppTab?,
    onSelect: (AppTab) -> Unit,
    content: @Composable (Modifier) -> Unit,
) {
    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            if (selected != null) HomeSurfaceTheme { AppDock(selected, onSelect) }
        },
    ) { padding ->
        content(Modifier.padding(padding).consumeWindowInsets(padding))
    }
}
