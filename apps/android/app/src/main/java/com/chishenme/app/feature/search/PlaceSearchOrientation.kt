package com.chishenme.app.feature.search

import com.chishenme.app.data.remote.PlaceSearchCoordinate
import com.chishenme.app.data.remote.PlaceSearchResult
import com.chishenme.app.domain.CoordinateCrsTransform
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max

internal data class PlaceSearchOrientationPoint(
    val rank: Int,
    val name: String,
    val xFraction: Float,
    val yFraction: Float,
    val direction: String,
)

internal data class PlaceSearchOrientationProjection(
    val points: List<PlaceSearchOrientationPoint>,
    val skippedCount: Int,
) {
    fun accessibilityDescription(): String = buildString {
        append("附近餐厅大致方位图，非道路导航图。")
        points.forEach { point ->
            append("第 ${point.rank} 项 ${point.name} 位于${point.direction}；")
        }
        if (skippedCount > 0) append("另有 $skippedCount 项无法安全绘制，请查看列表。")
    }
}

internal object PlaceSearchOrientationProjector {
    fun project(
        origin: PlaceSearchCoordinate,
        radiusMeters: Int,
        results: List<PlaceSearchResult>,
    ): PlaceSearchOrientationProjection {
        if (!origin.isUsable()) {
            return PlaceSearchOrientationProjection(emptyList(), results.size)
        }
        val calculated = results.mapNotNull { result ->
            val target = result.location
            if (!target.isUsable()) return@mapNotNull null
            val alignedOrigin = CoordinateCrsTransform.alignTo(
                latitude = origin.latitude,
                longitude = origin.longitude,
                source = origin.crs,
                target = target.crs,
            ) ?: return@mapNotNull null
            val originLatitude = alignedOrigin.latitude.toRadians()
            val targetLatitude = target.latitude.toRadians()
            val north = EARTH_RADIUS_METERS * (targetLatitude - originLatitude)
            val longitudeDelta = normalizedLongitudeDelta(
                target.longitude - alignedOrigin.longitude,
            ).toRadians()
            val east = EARTH_RADIUS_METERS * longitudeDelta * cos((originLatitude + targetLatitude) / 2.0)
            val distance = hypot(east, north)
            val maximum = max(radiusMeters.toDouble() * 1.5, 1_000.0)
            if (!east.isFinite() || !north.isFinite() || !distance.isFinite() || distance > maximum) {
                return@mapNotNull null
            }
            Calculated(result.rank, safeName(result.name), east, north, distance)
        }
        val scale = max(100.0, calculated.maxOfOrNull(Calculated::distance)?.times(1.15) ?: 100.0)
        val points = calculated.map { point ->
            PlaceSearchOrientationPoint(
                rank = point.rank,
                name = point.name,
                xFraction = (0.5 + point.east / scale * 0.4).toFloat().coerceIn(0.08f, 0.92f),
                yFraction = (0.5 - point.north / scale * 0.4).toFloat().coerceIn(0.08f, 0.92f),
                direction = direction(point.east, point.north, point.distance),
            )
        }
        return PlaceSearchOrientationProjection(points, results.size - points.size)
    }

    private data class Calculated(
        val rank: Int,
        val name: String,
        val east: Double,
        val north: Double,
        val distance: Double,
    )

    private fun direction(east: Double, north: Double, distance: Double): String {
        if (distance < 15.0) return "附近"
        val degrees = ((atan2(east, north) * 180.0 / PI) + 360.0) % 360.0
        return when {
            degrees < 22.5 || degrees >= 337.5 -> "北侧"
            degrees < 67.5 -> "东北侧"
            degrees < 112.5 -> "东侧"
            degrees < 157.5 -> "东南侧"
            degrees < 202.5 -> "南侧"
            degrees < 247.5 -> "西南侧"
            degrees < 292.5 -> "西侧"
            else -> "西北侧"
        }
    }

    private fun PlaceSearchCoordinate.isUsable(): Boolean =
        latitude.isFinite() && latitude in -90.0..90.0 &&
            longitude.isFinite() && longitude in -180.0..180.0

    private fun safeName(value: String): String = value
        .trim()
        .replace(Regex("[\\p{Cc}\\p{Cf}\\s]+"), " ")
        .replace(Regex("(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])"), "[已隐藏]")
        .take(80)
        .ifBlank { "未命名餐厅" }

    private fun normalizedLongitudeDelta(value: Double): Double = ((value + 540.0) % 360.0) - 180.0
    private fun Double.toRadians(): Double = this * PI / 180.0

    private const val EARTH_RADIUS_METERS = 6_371_008.8
}
