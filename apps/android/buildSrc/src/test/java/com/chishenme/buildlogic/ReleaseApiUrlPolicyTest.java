package com.chishenme.buildlogic;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ReleaseApiUrlPolicyTest {
    @Test
    public void acceptsPublicHttpsBaseUrls() {
        assertTrue(ReleaseApiUrlPolicy.isAllowed("https://api.chishenme.example.cn/"));
        assertTrue(ReleaseApiUrlPolicy.isAllowed("https://api.chishenme.example.cn/v1/"));
        assertTrue(ReleaseApiUrlPolicy.isAllowed("https://www.unfinished-era.com/"));
        assertTrue(ReleaseApiUrlPolicy.isAllowed("https://8.8.8.8/"));
        assertTrue(ReleaseApiUrlPolicy.isAllowed("https://[2606:4700:4700::1111]/"));
    }

    @Test
    public void sharedAlphaPolicyRejectsLocalOrCleartextEndpoints() {
        assertFalse(ReleaseApiUrlPolicy.isAllowed("http://www.unfinished-era.com/"));
        assertFalse(ReleaseApiUrlPolicy.isAllowed("http://127.0.0.1:3001/"));
        assertFalse(ReleaseApiUrlPolicy.isAllowed("https://127.0.0.1:3001/"));
        assertFalse(ReleaseApiUrlPolicy.isAllowed("https://localhost:3001/"));
    }

    @Test
    public void rejectsWrongSchemeShapeAndUrlExtras() {
        String[] rejected = {
            null,
            "",
            "http://api.chishenme.example.cn/",
            "https://api.chishenme.example.cn",
            "https://user:secret@api.chishenme.example.cn/",
            "https://api.chishenme.example.cn/?region=cn",
            "https://api.chishenme.example.cn/#health",
            "https://api.chishenme.example.cn:0/",
            "https://single-label/",
        };
        for (String value : rejected) {
            assertFalse(String.valueOf(value), ReleaseApiUrlPolicy.isAllowed(value));
        }
    }

    @Test
    public void rejectsLocalAndReservedDnsNames() {
        String[] rejected = {
            "https://localhost/",
            "https://api.localhost/",
            "https://service.local/",
            "https://service.internal/",
            "https://service.invalid/",
            "https://service.test/",
            "https://example.com/",
            "https://api.example.org/",
            "https://service.home.arpa/",
        };
        for (String value : rejected) {
            assertFalse(value, ReleaseApiUrlPolicy.isAllowed(value));
        }
    }

    @Test
    public void rejectsPrivateLoopbackAndReservedIpv4Ranges() {
        String[] rejected = {
            "https://0.0.0.0/",
            "https://10.1.2.3/",
            "https://100.64.0.1/",
            "https://127.0.0.1/",
            "https://169.254.10.20/",
            "https://172.16.0.1/",
            "https://192.168.1.10/",
            "https://192.0.2.1/",
            "https://198.18.0.1/",
            "https://198.51.100.5/",
            "https://203.0.113.8/",
            "https://224.0.0.1/",
            "https://127.1/",
        };
        for (String value : rejected) {
            assertFalse(value, ReleaseApiUrlPolicy.isAllowed(value));
        }
    }

    @Test
    public void rejectsPrivateLoopbackAndReservedIpv6Ranges() {
        String[] rejected = {
            "https://[::]/",
            "https://[::1]/",
            "https://[fc00::1]/",
            "https://[fe80::1]/",
            "https://[2001:db8::1]/",
            "https://[3fff::1]/",
        };
        for (String value : rejected) {
            assertFalse(value, ReleaseApiUrlPolicy.isAllowed(value));
        }
    }
}
