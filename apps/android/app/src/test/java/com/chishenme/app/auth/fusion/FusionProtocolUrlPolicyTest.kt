package com.chishenme.app.auth.fusion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FusionProtocolUrlPolicyTest {
    @Test
    fun `allows only exact HTTPS carrier agreement hosts from pinned SDK`() {
        assertTrue(
            FusionProtocolUrlPolicy.isAllowed(
                "https://wap.cmpassport.com/resources/html/contract.html",
            ),
        )
        assertTrue(
            FusionProtocolUrlPolicy.isAllowed(
                "https://opencloud.wostore.cn/authz/resource/html/disclaimer.html?fromsdk=true",
            ),
        )
        assertTrue(
            FusionProtocolUrlPolicy.isAllowed(
                "https://msv6.wosms.cn/html/oauth/protocol2.html",
            ),
        )
        assertTrue(
            FusionProtocolUrlPolicy.isAllowed(
                "https://e.189.cn/sdk/agreement/detail.do?hidetop=true",
            ),
        )

        assertFalse(FusionProtocolUrlPolicy.isAllowed("http://wap.cmpassport.com/agreement"))
        assertFalse(FusionProtocolUrlPolicy.isAllowed("https://evil.wap.cmpassport.com/agreement"))
        assertFalse(FusionProtocolUrlPolicy.isAllowed("https://wap.cmpassport.com.evil.test/"))
        assertFalse(FusionProtocolUrlPolicy.isAllowed("https://user@wap.cmpassport.com/"))
        assertFalse(FusionProtocolUrlPolicy.isAllowed("https://wap.cmpassport.com:8443/"))
        assertFalse(FusionProtocolUrlPolicy.isAllowed("file:///data/local/tmp/agreement.html"))
        assertFalse(FusionProtocolUrlPolicy.isAllowed(null))
    }
}
