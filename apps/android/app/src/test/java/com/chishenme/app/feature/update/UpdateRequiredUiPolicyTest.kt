package com.chishenme.app.feature.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRequiredUiPolicyTest {
    @Test
    fun `guest and checking states never show destructive account controls`() {
        assertFalse(showSignedInDataRightsControls(checking = true, signedIn = true))
        assertFalse(showSignedInDataRightsControls(checking = true, signedIn = false))
        assertFalse(showSignedInDataRightsControls(checking = false, signedIn = false))
        assertFalse(showLocalLogoutControl(checking = true, localSessionMaterialPresent = true))
        assertFalse(showLocalLogoutControl(checking = false, localSessionMaterialPresent = false))
    }

    @Test
    fun `verified local signed in state shows isolated data rights controls`() {
        assertTrue(showSignedInDataRightsControls(checking = false, signedIn = true))
        assertTrue(showLocalLogoutControl(checking = false, localSessionMaterialPresent = true))
    }
}
