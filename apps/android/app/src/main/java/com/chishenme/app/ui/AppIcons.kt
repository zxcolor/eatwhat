package com.chishenme.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * The small set of product-specific icons that is not available in
 * material-icons-core. Keeping them local avoids loading the full generated
 * extended Material icon catalog into debug builds and on slow test devices.
 */
object AppIcons {
    val Restaurant: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
        ImageVector.Builder(
            name = "Restaurant",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(fill = SolidColor(Color.Black)) {
                moveTo(3f, 2f)
                lineTo(5f, 2f)
                lineTo(5f, 9f)
                lineTo(7f, 9f)
                lineTo(7f, 2f)
                lineTo(9f, 2f)
                lineTo(9f, 9f)
                lineTo(11f, 9f)
                lineTo(11f, 2f)
                lineTo(13f, 2f)
                lineTo(13f, 9f)
                curveTo(13f, 11.21f, 11.21f, 13f, 9f, 13f)
                lineTo(9f, 22f)
                lineTo(7f, 22f)
                lineTo(7f, 13f)
                curveTo(4.79f, 13f, 3f, 11.21f, 3f, 9f)
                close()
                moveTo(16f, 6f)
                curveTo(16f, 3.79f, 17.79f, 2f, 20f, 2f)
                lineTo(21f, 2f)
                lineTo(21f, 22f)
                lineTo(19f, 22f)
                lineTo(19f, 14f)
                lineTo(16f, 14f)
                close()
            }
        }.build()
    }

    val MyLocation: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
        ImageVector.Builder(
            name = "MyLocation",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(fill = SolidColor(Color.Black)) {
                moveTo(11f, 2f)
                lineTo(13f, 2f)
                lineTo(13f, 5.08f)
                curveTo(16.07f, 5.52f, 18.48f, 7.93f, 18.92f, 11f)
                lineTo(22f, 11f)
                lineTo(22f, 13f)
                lineTo(18.92f, 13f)
                curveTo(18.48f, 16.07f, 16.07f, 18.48f, 13f, 18.92f)
                lineTo(13f, 22f)
                lineTo(11f, 22f)
                lineTo(11f, 18.92f)
                curveTo(7.93f, 18.48f, 5.52f, 16.07f, 5.08f, 13f)
                lineTo(2f, 13f)
                lineTo(2f, 11f)
                lineTo(5.08f, 11f)
                curveTo(5.52f, 7.93f, 7.93f, 5.52f, 11f, 5.08f)
                close()
                moveTo(12f, 7f)
                curveTo(9.24f, 7f, 7f, 9.24f, 7f, 12f)
                curveTo(7f, 14.76f, 9.24f, 17f, 12f, 17f)
                curveTo(14.76f, 17f, 17f, 14.76f, 17f, 12f)
                curveTo(17f, 9.24f, 14.76f, 7f, 12f, 7f)
                close()
            }
        }.build()
    }

    val AccessTime: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
        ImageVector.Builder(
            name = "AccessTime",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(12f, 3f)
                curveTo(7.03f, 3f, 3f, 7.03f, 3f, 12f)
                curveTo(3f, 16.97f, 7.03f, 21f, 12f, 21f)
                curveTo(16.97f, 21f, 21f, 16.97f, 21f, 12f)
                curveTo(21f, 7.03f, 16.97f, 3f, 12f, 3f)
                close()
                moveTo(12f, 7f)
                lineTo(12f, 12f)
                lineTo(15.5f, 14f)
            }
        }.build()
    }

    val ContentCopy: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
        ImageVector.Builder(
            name = "ContentCopy",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(fill = SolidColor(Color.Black)) {
                moveTo(16f, 1f)
                lineTo(4f, 1f)
                curveTo(2.9f, 1f, 2f, 1.9f, 2f, 3f)
                lineTo(2f, 17f)
                lineTo(4f, 17f)
                lineTo(4f, 3f)
                lineTo(16f, 3f)
                close()
                moveTo(19f, 5f)
                lineTo(8f, 5f)
                curveTo(6.9f, 5f, 6f, 5.9f, 6f, 7f)
                lineTo(6f, 21f)
                curveTo(6f, 22.1f, 6.9f, 23f, 8f, 23f)
                lineTo(19f, 23f)
                curveTo(20.1f, 23f, 21f, 22.1f, 21f, 21f)
                lineTo(21f, 7f)
                curveTo(21f, 5.9f, 20.1f, 5f, 19f, 5f)
                close()
                moveTo(19f, 21f)
                lineTo(8f, 21f)
                lineTo(8f, 7f)
                lineTo(19f, 7f)
                close()
            }
        }.build()
    }

    val Tune: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
        ImageVector.Builder(
            name = "Tune",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(4f, 6f)
                lineTo(20f, 6f)
                moveTo(4f, 12f)
                lineTo(20f, 12f)
                moveTo(4f, 18f)
                lineTo(20f, 18f)
            }
            path(fill = SolidColor(Color.Black)) {
                moveTo(8f, 3.5f)
                curveTo(9.38f, 3.5f, 10.5f, 4.62f, 10.5f, 6f)
                curveTo(10.5f, 7.38f, 9.38f, 8.5f, 8f, 8.5f)
                curveTo(6.62f, 8.5f, 5.5f, 7.38f, 5.5f, 6f)
                curveTo(5.5f, 4.62f, 6.62f, 3.5f, 8f, 3.5f)
                close()
                moveTo(16f, 9.5f)
                curveTo(17.38f, 9.5f, 18.5f, 10.62f, 18.5f, 12f)
                curveTo(18.5f, 13.38f, 17.38f, 14.5f, 16f, 14.5f)
                curveTo(14.62f, 14.5f, 13.5f, 13.38f, 13.5f, 12f)
                curveTo(13.5f, 10.62f, 14.62f, 9.5f, 16f, 9.5f)
                close()
                moveTo(10f, 15.5f)
                curveTo(11.38f, 15.5f, 12.5f, 16.62f, 12.5f, 18f)
                curveTo(12.5f, 19.38f, 11.38f, 20.5f, 10f, 20.5f)
                curveTo(8.62f, 20.5f, 7.5f, 19.38f, 7.5f, 18f)
                curveTo(7.5f, 16.62f, 8.62f, 15.5f, 10f, 15.5f)
                close()
            }
        }.build()
    }

    val DarkMode: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
        ImageVector.Builder(
            name = "DarkMode",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(fill = SolidColor(Color.Black)) {
                moveTo(12.1f, 22f)
                curveTo(6.58f, 22f, 2.1f, 17.52f, 2.1f, 12f)
                curveTo(2.1f, 6.48f, 6.58f, 2f, 12.1f, 2f)
                curveTo(12.56f, 2f, 13.01f, 2.03f, 13.46f, 2.09f)
                curveTo(10.85f, 3.31f, 9.04f, 5.96f, 9.04f, 9.03f)
                curveTo(9.04f, 13.46f, 12.63f, 17.05f, 17.06f, 17.05f)
                curveTo(18.23f, 17.05f, 19.35f, 16.8f, 20.36f, 16.35f)
                curveTo(18.72f, 19.7f, 15.51f, 22f, 12.1f, 22f)
                close()
            }
        }.build()
    }
}
