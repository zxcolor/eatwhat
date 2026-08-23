package com.chishenme.app.feature.search

import com.chishenme.app.data.PlaceSearchRepository
import com.chishenme.app.data.remote.PlaceSearchApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.http.POST

class PlaceSearchMemoryBoundaryTest {
    @Test
    fun `search ViewModel depends only on its in-memory repository boundary`() {
        val parameterTypes = PlaceSearchViewModel::class.java.declaredConstructors
            .flatMap { it.parameterTypes.toList() }
            .map { it.name }

        assertTrue(parameterTypes.contains(PlaceSearchRepository::class.java.name))
        assertFalse(parameterTypes.any { it.contains("DataStore") })
        assertFalse(parameterTypes.any { it.contains("SavedStateHandle") })
        assertFalse(parameterTypes.any { it.contains("DecisionHistory") })
        assertFalse(parameterTypes.any { it.contains("RecommendationRepository") })
    }

    @Test
    fun `search transport exposes only the dedicated static endpoint`() {
        val methods = PlaceSearchApi::class.java.declaredMethods
        assertEquals(1, methods.size)
        assertEquals("v1/place-search", methods.single().getAnnotation(POST::class.java).value)
        assertFalse(methods.single().name.contains("event", ignoreCase = true))
        assertFalse(methods.single().name.contains("history", ignoreCase = true))
    }
}
