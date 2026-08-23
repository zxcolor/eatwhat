package com.chishenme.app.feature.saved

import com.chishenme.app.data.remote.PersistenceCapabilities
import org.junit.Assert.assertEquals
import org.junit.Test

class SavedResourceSectionsTest {
    @Test
    fun `history only capability does not expose favorites or feedback pages`() {
        assertEquals(
            setOf(SavedResourcesSection.HISTORY),
            enabledSavedResourceSections(
                PersistenceCapabilities(
                    favoritesEnabled = false,
                    historyEnabled = true,
                    privateFeedbackEnabled = false,
                    savedResourceIdsEnabled = true,
                ),
            ),
        )
    }

    @Test
    fun `each resource page follows only its own capability`() {
        assertEquals(
            setOf(SavedResourcesSection.FAVORITES, SavedResourcesSection.PRIVATE_FEEDBACK),
            enabledSavedResourceSections(
                PersistenceCapabilities(
                    favoritesEnabled = true,
                    historyEnabled = false,
                    privateFeedbackEnabled = true,
                    savedResourceIdsEnabled = false,
                ),
            ),
        )
        assertEquals(emptySet<SavedResourcesSection>(), enabledSavedResourceSections(null))
    }
}
