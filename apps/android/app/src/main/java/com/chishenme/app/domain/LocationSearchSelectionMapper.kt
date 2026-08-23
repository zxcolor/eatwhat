package com.chishenme.app.domain

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.LocationSearchDataMode
import com.chishenme.app.data.remote.LocationSearchPlace

object LocationSearchSelectionMapper {
    fun toLocationChoice(
        place: LocationSearchPlace,
        dataMode: LocationSearchDataMode,
    ): LocationChoice = LocationChoice(
        label = place.name,
        coordinate = Coordinate(
            latitude = place.location.latitude,
            longitude = place.location.longitude,
            accuracyMeters = null,
            crs = place.location.crs,
        ),
        // Provider identity and attribution are deliberately not retained.
        isDemonstration = dataMode == LocationSearchDataMode.DEMO,
        isApproximate = false,
    )
}
