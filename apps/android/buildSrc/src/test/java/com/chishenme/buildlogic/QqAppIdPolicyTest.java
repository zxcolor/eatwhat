package com.chishenme.buildlogic;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class QqAppIdPolicyTest {
    @Test
    public void emptyAppIdKeepsOptionalQqDisabledWithoutBlockingRelease() {
        assertTrue(QqAppIdPolicy.isAllowedOrDisabled(null));
        assertTrue(QqAppIdPolicy.isAllowedOrDisabled(""));
        assertTrue(QqAppIdPolicy.isAllowedOrDisabled("   "));
    }

    @Test
    public void configuredAppIdMustBeStrictNumericValue() {
        assertTrue(QqAppIdPolicy.isAllowedOrDisabled("1101234567"));
        assertFalse(QqAppIdPolicy.isAllowedOrDisabled("01101234567"));
        assertFalse(QqAppIdPolicy.isAllowedOrDisabled("11012abc"));
        assertFalse(QqAppIdPolicy.isAllowedOrDisabled("1234"));
        assertFalse(QqAppIdPolicy.isAllowedOrDisabled("12345678901234567"));
    }
}
