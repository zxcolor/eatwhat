package com.chishenme.app.domain

import com.chishenme.app.data.remote.CoordinateReferenceSystem
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

internal data class CrsAlignedCoordinate(
    val latitude: Double,
    val longitude: Double,
    val crs: CoordinateReferenceSystem,
)

/** Provider-neutral CRS alignment for transient, on-device presentation math. */
internal object CoordinateCrsTransform {
    fun alignTo(
        latitude: Double,
        longitude: Double,
        source: CoordinateReferenceSystem,
        target: CoordinateReferenceSystem,
    ): CrsAlignedCoordinate? {
        if (!latitude.isFinite() || latitude !in -90.0..90.0 ||
            !longitude.isFinite() || longitude !in -180.0..180.0
        ) return null
        if (source == target) return CrsAlignedCoordinate(latitude, longitude, target)
        if (source != CoordinateReferenceSystem.WGS84 ||
            target != CoordinateReferenceSystem.GCJ02
        ) return null
        if (outsideMainlandChina(latitude, longitude)) {
            return CrsAlignedCoordinate(latitude, longitude, target)
        }

        val latitudeRadians = latitude / 180.0 * PI
        val sineLatitude = sin(latitudeRadians)
        val magic = 1 - GCJ_ECCENTRICITY_SQUARED * sineLatitude * sineLatitude
        val squareRootMagic = sqrt(magic)
        val latitudeDelta = transformLatitude(longitude - 105, latitude - 35) * 180.0 /
            (GCJ_SEMI_MAJOR_AXIS * (1 - GCJ_ECCENTRICITY_SQUARED) /
                (magic * squareRootMagic) * PI)
        val longitudeDelta = transformLongitude(longitude - 105, latitude - 35) * 180.0 /
            (GCJ_SEMI_MAJOR_AXIS / squareRootMagic * cos(latitudeRadians) * PI)
        val convertedLatitude = latitude + latitudeDelta
        val convertedLongitude = longitude + longitudeDelta
        return if (convertedLatitude.isFinite() && convertedLongitude.isFinite()) {
            CrsAlignedCoordinate(convertedLatitude, convertedLongitude, target)
        } else {
            null
        }
    }

    private fun outsideMainlandChina(latitude: Double, longitude: Double): Boolean =
        longitude < 72.004 || longitude > 137.8347 ||
            latitude < 0.8293 || latitude > 55.8271

    private fun transformLatitude(longitudeOffset: Double, latitudeOffset: Double): Double {
        var value = -100.0 + 2 * longitudeOffset + 3 * latitudeOffset +
            0.2 * latitudeOffset * latitudeOffset +
            0.1 * longitudeOffset * latitudeOffset +
            0.2 * sqrt(abs(longitudeOffset))
        value += (20 * sin(6 * longitudeOffset * PI) +
            20 * sin(2 * longitudeOffset * PI)) * 2 / 3
        value += (20 * sin(latitudeOffset * PI) +
            40 * sin(latitudeOffset / 3 * PI)) * 2 / 3
        value += (160 * sin(latitudeOffset / 12 * PI) +
            320 * sin(latitudeOffset * PI / 30)) * 2 / 3
        return value
    }

    private fun transformLongitude(longitudeOffset: Double, latitudeOffset: Double): Double {
        var value = 300.0 + longitudeOffset + 2 * latitudeOffset +
            0.1 * longitudeOffset * longitudeOffset +
            0.1 * longitudeOffset * latitudeOffset +
            0.1 * sqrt(abs(longitudeOffset))
        value += (20 * sin(6 * longitudeOffset * PI) +
            20 * sin(2 * longitudeOffset * PI)) * 2 / 3
        value += (20 * sin(longitudeOffset * PI) +
            40 * sin(longitudeOffset / 3 * PI)) * 2 / 3
        value += (150 * sin(longitudeOffset / 12 * PI) +
            300 * sin(longitudeOffset / 30 * PI)) * 2 / 3
        return value
    }

    private const val GCJ_SEMI_MAJOR_AXIS = 6_378_245.0
    private const val GCJ_ECCENTRICITY_SQUARED = 0.006693421622965943
}
