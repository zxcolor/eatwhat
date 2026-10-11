package com.chishenme.app.feature.account

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.chishenme.app.ui.AppDock
import com.chishenme.app.ui.AppIcons
import com.chishenme.app.ui.AppTab
import com.chishenme.app.ui.AppTopBar

/** Settings stay reachable for guests without entering the authentication flow. */
@Composable
fun PersonalScreen(
    onSelectTab: (AppTab) -> Unit,
    onOpenAccount: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenConditions: () -> Unit,
) {
    Scaffold(
        topBar = { AppTopBar(title = "个人", subtitle = "账号、偏好与设置") },
        bottomBar = { AppDock(AppTab.PERSONAL, onSelectTab) },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            PersonalEntry("账号与安全", "登录、账号资料与数据管理", Icons.Rounded.Person, "personal-account", onOpenAccount)
            PersonalEntry("本次推荐条件", "预算、时间、距离与用餐偏好", AppIcons.Tune, "personal-conditions", onOpenConditions)
            PersonalEntry("设置", "主题、隐私与偏好设置", Icons.Rounded.Settings, "personal-settings", onOpenSettings)
        }
    }
}

@Composable
private fun PersonalEntry(title: String, subtitle: String, icon: ImageVector, tag: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag(tag),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(26.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("›", style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
