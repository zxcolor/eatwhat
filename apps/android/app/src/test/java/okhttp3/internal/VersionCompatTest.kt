package okhttp3.internal

import org.junit.Assert.assertTrue
import org.junit.Test

class VersionCompatTest {
    @Test
    fun `QQ compatibility probe receives the required OkHttp 3 prefix`() {
        assertTrue(Version.userAgent().startsWith("okhttp/3"))
    }
}
