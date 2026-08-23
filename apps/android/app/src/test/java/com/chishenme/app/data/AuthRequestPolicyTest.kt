package com.chishenme.app.data

import com.chishenme.app.data.remote.OtpPurpose
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthRequestPolicyTest {
    @Test
    fun `only bind OTP requests require bearer`() {
        assertFalse(otpPurposeRequiresAuthentication(OtpPurpose.REGISTER))
        assertFalse(otpPurposeRequiresAuthentication(OtpPurpose.LOGIN))
        assertTrue(otpPurposeRequiresAuthentication(OtpPurpose.BIND))
    }
}
