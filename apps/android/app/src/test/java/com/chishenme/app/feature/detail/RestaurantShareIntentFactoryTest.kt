package com.chishenme.app.feature.detail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RestaurantShareIntentFactoryTest {
    @Test
    fun imageShareSpecUsesOnlyContentUriAndTemporaryReadGrant() {
        val uri = "content://com.chishenme.app.debug.share-file-provider/restaurant_share_cards/restaurant_random.png"

        val spec = RestaurantShareIntentFactory.createSpec(uri)!!

        assertEquals("android.intent.action.SEND", spec.action)
        assertEquals("image/png", spec.mimeType)
        assertEquals(uri, spec.streamUri)
        assertTrue(spec.grantReadPermission)
        assertFalse(spec.toString().contains("write", ignoreCase = true))
        assertFalse(spec.toString().contains("EXTRA_TEXT"))
    }

    @Test
    fun nonContentAndWhitespaceUrisFailClosed() {
        assertNull(RestaurantShareIntentFactory.createSpec("file:///data/private/card.png"))
        assertNull(RestaurantShareIntentFactory.createSpec("https://example.invalid/card.png"))
        assertNull(RestaurantShareIntentFactory.createSpec("content://authority/card with space.png"))
    }
}
