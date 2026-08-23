package com.chishenme.app.feature.decision

import org.junit.Assert.assertFalse
import org.junit.Test

class DecisionViewModelMemoryBoundaryTest {
    @Test
    fun `recommendation detail and location search session are not backed by saved state`() {
        val parameterTypes = DecisionViewModel::class.java.declaredConstructors
            .flatMap { it.parameterTypes.toList() }
            .map { it.name }

        assertFalse(parameterTypes.any { it.contains("SavedStateHandle") })
        assertFalse(parameterTypes.any { it == "android.os.Bundle" })
    }
}
