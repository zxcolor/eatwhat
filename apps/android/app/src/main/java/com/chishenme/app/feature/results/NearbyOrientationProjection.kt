package com.chishenme.app.feature.results

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.DataRightsMode
import com.chishenme.app.data.remote.RecommendationContext
import com.chishenme.app.data.remote.RecommendationResult
import com.chishenme.app.domain.CoordinateCrsTransform
import com.chishenme.app.domain.CrsAlignedCoordinate
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

internal enum class NearbyDirection(val displayName: String) {
    NEARBY("就在附近"),
    NORTH("北侧"),
    NORTH_EAST("东北侧"),
    EAST("东侧"),
    SOUTH_EAST("东南侧"),
    SOUTH("南侧"),
    SOUTH_WEST("西南侧"),
    WEST("西侧"),
    NORTH_WEST("西北侧"),
}

/** Contains no coordinate, CRS, provider identifier or result token. */
internal data class NearbyOrientationPoint(
    val rank: Int,
    val restaurantName: String,
    val isPrimary: Boolean,
    val xFraction: Float,
    val yFraction: Float,
    val calculatedDistanceMeters: Double,
    val direction: NearbyDirection,
    val collisionOffsetApplied: Boolean,
) {
    fun accessibilityDescription(dataRightsMode: DataRightsMode): String {
        val orderDescription = if (dataRightsMode == DataRightsMode.LIVE_DISPLAY_ONLY) {
            val role = if (isPrimary) "首个候选" else "其他候选"
            "数据源顺序第 " + rank + " 个，" + role
        } else {
            val role = if (isPrimary) "主推荐" else "备选"
            "第 " + rank + " 名，" + role
        }
        return orderDescription + "，" + restaurantName + "，" + direction.displayName + "，" +
            distanceForSpeech(calculatedDistanceMeters)
    }
}

internal data class NearbyOrientationProjection(
    val points: List<NearbyOrientationPoint>,
    val skippedCount: Int,
    val originUsable: Boolean,
    val scaleMeters: Double,
) {
    fun accessibilitySummary(dataRightsMode: DataRightsMode): String = buildString {
        append("附近方位图，非道路导航图。")
        if (!originUsable) {
            append("本次起点信息异常，无法绘制；所有结果仍可在列表查看。")
            return@buildString
        }
        if (points.isEmpty()) {
            append("没有可安全绘制的结果，列表仍可使用。")
        } else {
            points.forEachIndexed { index, point ->
                if (index > 0) append("；")
                append(point.accessibilityDescription(dataRightsMode))
            }
            append("。")
        }
        if (skippedCount > 0) {
            append("另有 $skippedCount 条因坐标基准不一致或信息异常未绘制，可在列表查看。")
        }
    }
}

private data class ProjectionCandidate(
    val rank: Int,
    val restaurantName: String,
    val coordinate: Coordinate,
)

private data class CalculatedPoint(
    val rank: Int,
    val restaurantName: String,
    val eastMeters: Double,
    val northMeters: Double,
    val distanceMeters: Double,
)

internal object NearbyOrientationProjector {
    fun project(
        context: RecommendationContext,
        results: List<RecommendationResult>,
    ): NearbyOrientationProjection {
        val candidates = results.take(MAX_RESULTS).map { result ->
            ProjectionCandidate(
                rank = result.rank,
                restaurantName = safeRestaurantName(result),
                coordinate = result.location,
            )
        }
        val origin = context.location
        if (!origin.isUsable()) {
            return NearbyOrientationProjection(
                points = emptyList(),
                skippedCount = candidates.size,
                originUsable = false,
                scaleMeters = safeScaleHint(context.radiusMeters),
            )
        }

        val maxAcceptedDistance = max(
            safeScaleHint(context.radiusMeters) * MAX_RADIUS_MULTIPLIER,
            MIN_ANOMALY_DISTANCE_METERS,
        )
        val calculated = candidates.mapNotNull { candidate ->
            if (!candidate.coordinate.isUsable()) {
                return@mapNotNull null
            }
            val alignedOrigin = CoordinateCrsTransform.alignTo(
                latitude = origin.latitude,
                longitude = origin.longitude,
                source = origin.crs,
                target = candidate.coordinate.crs,
            ) ?: return@mapNotNull null
            calculate(alignedOrigin, candidate)?.takeIf { point ->
                point.distanceMeters.isFinite() && point.distanceMeters <= maxAcceptedDistance
            }
        }
        val scale = max(
            MIN_SCALE_METERS,
            calculated.maxOfOrNull(CalculatedPoint::distanceMeters)?.times(SCALE_PADDING) ?: 0.0,
        )
        val occupied = mutableListOf(CENTER_FRACTION to CENTER_FRACTION)
        val projectedPoints = calculated.sortedBy(CalculatedPoint::rank).map { point ->
            val rawX = (CENTER_FRACTION + (point.eastMeters / scale * MAP_RADIUS_FRACTION)).toFloat()
                .coerceIn(MIN_MARKER_FRACTION, MAX_MARKER_FRACTION)
            val rawY = (CENTER_FRACTION - (point.northMeters / scale * MAP_RADIUS_FRACTION)).toFloat()
                .coerceIn(MIN_MARKER_FRACTION, MAX_MARKER_FRACTION)
            val placed = separateCollision(rawX, rawY, point.rank, occupied)
            occupied += placed
            NearbyOrientationPoint(
                rank = point.rank,
                restaurantName = point.restaurantName,
                isPrimary = point.rank == 1,
                xFraction = placed.first,
                yFraction = placed.second,
                calculatedDistanceMeters = point.distanceMeters,
                direction = direction(point.eastMeters, point.northMeters, point.distanceMeters),
                collisionOffsetApplied =
                    abs(placed.first - rawX) > FRACTION_EPSILON ||
                        abs(placed.second - rawY) > FRACTION_EPSILON,
            )
        }

        return NearbyOrientationProjection(
            points = projectedPoints,
            skippedCount = candidates.size - projectedPoints.size,
            originUsable = true,
            scaleMeters = scale,
        )
    }

    private fun calculate(
        origin: CrsAlignedCoordinate,
        candidate: ProjectionCandidate,
    ): CalculatedPoint? {
        val originLatitude = origin.latitude.toRadians()
        val candidateLatitude = candidate.coordinate.latitude.toRadians()
        val deltaLatitude = candidateLatitude - originLatitude
        val deltaLongitude = normalizedLongitudeDelta(
            candidate.coordinate.longitude - origin.longitude,
        ).toRadians()
        val meanLatitude = (originLatitude + candidateLatitude) / 2.0
        val east = EARTH_RADIUS_METERS * deltaLongitude * cos(meanLatitude)
        val north = EARTH_RADIUS_METERS * deltaLatitude
        val distance = hypot(east, north)
        if (!east.isFinite() || !north.isFinite() || !distance.isFinite()) return null
        return CalculatedPoint(
            rank = candidate.rank,
            restaurantName = candidate.restaurantName,
            eastMeters = east,
            northMeters = north,
            distanceMeters = distance,
        )
    }

    private fun separateCollision(
        rawX: Float,
        rawY: Float,
        rank: Int,
        occupied: List<Pair<Float, Float>>,
    ): Pair<Float, Float> {
        var candidate = rawX to rawY
        repeat(MAX_COLLISION_ATTEMPTS) { attempt ->
            if (occupied.none { existing -> fractionDistance(candidate, existing) < MIN_POINT_SEPARATION }) {
                return candidate
            }
            val angle = ((rank * GOLDEN_ANGLE_DEGREES) + attempt * COLLISION_STEP_DEGREES).toRadians()
            val radius = BASE_COLLISION_OFFSET + (attempt / COLLISION_RING_SIZE) * COLLISION_RING_STEP
            candidate = (
                rawX + (cos(angle) * radius).toFloat()
                ).coerceIn(MIN_MARKER_FRACTION, MAX_MARKER_FRACTION) to (
                rawY + (sin(angle) * radius).toFloat()
                ).coerceIn(MIN_MARKER_FRACTION, MAX_MARKER_FRACTION)
        }
        return candidate
    }

    private fun direction(east: Double, north: Double, distance: Double): NearbyDirection {
        if (distance < NEARBY_THRESHOLD_METERS) return NearbyDirection.NEARBY
        val degrees = ((atan2(east, north) * 180.0 / PI) + 360.0) % 360.0
        return when {
            degrees < 22.5 || degrees >= 337.5 -> NearbyDirection.NORTH
            degrees < 67.5 -> NearbyDirection.NORTH_EAST
            degrees < 112.5 -> NearbyDirection.EAST
            degrees < 157.5 -> NearbyDirection.SOUTH_EAST
            degrees < 202.5 -> NearbyDirection.SOUTH
            degrees < 247.5 -> NearbyDirection.SOUTH_WEST
            degrees < 292.5 -> NearbyDirection.WEST
            else -> NearbyDirection.NORTH_WEST
        }
    }

    private fun Coordinate.isUsable(): Boolean =
        latitude.isFinite() &&
            longitude.isFinite() &&
            latitude in -90.0..90.0 &&
            longitude in -180.0..180.0 &&
            accuracyMeters?.let { accuracy ->
                !accuracy.isFinite() || accuracy < 0.0 || accuracy > MAX_ACCURACY_METERS
            } != true

    private fun safeRestaurantName(result: RecommendationResult): String {
        val normalized = result.name.trim().replace(CONTROL_OR_WHITESPACE, " ")
        val redactions = listOf(
            result.resultToken,
            result.location.latitude.toString(),
            result.location.longitude.toString(),
            String.format(Locale.ROOT, "%.6f", result.location.latitude),
            String.format(Locale.ROOT, "%.6f", result.location.longitude),
        ).filter(String::isNotBlank).distinct()
        val redacted = redactions.fold(normalized) { value, sensitive ->
            value.replace(sensitive, "[已隐藏]")
        }.replace(PRECISE_COORDINATE_PATTERN, "[坐标已隐藏]")
            .replace(OPAQUE_TOKEN_PATTERN, "[令牌已隐藏]")
        return redacted.take(MAX_NAME_LENGTH).trim().ifBlank { "未命名餐厅" }
    }

    private fun normalizedLongitudeDelta(delta: Double): Double = ((delta + 540.0) % 360.0) - 180.0
    private fun Double.toRadians(): Double = this * PI / 180.0
    private fun safeScaleHint(radiusMeters: Int): Double =
        radiusMeters.takeIf { it in 1..MAX_RADIUS_METERS }?.toDouble() ?: DEFAULT_SCALE_METERS

    private fun fractionDistance(first: Pair<Float, Float>, second: Pair<Float, Float>): Double =
        hypot(
            (first.first - second.first).toDouble(),
            (first.second - second.second).toDouble(),
        )

    private val CONTROL_OR_WHITESPACE = Regex("[\\p{Cc}\\p{Cf}\\s]+")
    private val PRECISE_COORDINATE_PATTERN = Regex("(?<![\\d.])[+-]?\\d{1,3}\\.\\d{4,}(?![\\d.])")
    private val OPAQUE_TOKEN_PATTERN = Regex(
        "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])",
    )
    private const val EARTH_RADIUS_METERS = 6_371_008.8
    private const val MAX_RESULTS = 3
    private const val MAX_RADIUS_METERS = 10_000
    private const val MAX_ACCURACY_METERS = 10_000.0
    private const val DEFAULT_SCALE_METERS = 1_500.0
    private const val MAX_RADIUS_MULTIPLIER = 1.5
    private const val MIN_ANOMALY_DISTANCE_METERS = 1_000.0
    private const val MIN_SCALE_METERS = 100.0
    private const val SCALE_PADDING = 1.18
    private const val MAP_RADIUS_FRACTION = 0.4
    private const val CENTER_FRACTION = 0.5f
    private const val MIN_MARKER_FRACTION = 0.08f
    private const val MAX_MARKER_FRACTION = 0.92f
    private const val MIN_POINT_SEPARATION = 0.13
    private const val MAX_COLLISION_ATTEMPTS = 16
    private const val GOLDEN_ANGLE_DEGREES = 137.508
    private const val COLLISION_STEP_DEGREES = 61.0
    private const val BASE_COLLISION_OFFSET = 0.11
    private const val COLLISION_RING_SIZE = 4
    private const val COLLISION_RING_STEP = 0.045
    private const val FRACTION_EPSILON = 0.0001f
    private const val NEARBY_THRESHOLD_METERS = 15.0
    private const val MAX_NAME_LENGTH = 80
}

private fun distanceForSpeech(distanceMeters: Double): String = if (distanceMeters < 1_000.0) {
    "约 " + distanceMeters.toInt() + " 米"
} else {
    "约 " + String.format(Locale.CHINA, "%.1f", distanceMeters / 1_000.0) + " 公里"
}
