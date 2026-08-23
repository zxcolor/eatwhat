package com.chishenme.app.data.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalSerializationApi::class)
class OAuthStateRequestSerializationTest {
    private val json = Json { explicitNulls = false }

    @Test
    fun `wechat registration binds installation and phone challenge`() {
        val encoded = json.encodeToString(
            OAuthStateRequest(
                provider = AuthIdentityType.WECHAT,
                purpose = OAuthPurpose.REGISTER,
                installationId = "11111111-1111-4111-8111-111111111111",
                phoneChallengeId = "22222222-2222-4222-8222-222222222222",
            ),
        )

        assertTrue(encoded.contains("\"installationId\""))
        assertTrue(encoded.contains("\"phoneChallengeId\""))
    }

    @Test
    fun `wechat login and QQ bind omit phone registration flow`() {
        listOf(
            AuthIdentityType.WECHAT to OAuthPurpose.LOGIN,
            AuthIdentityType.QQ to OAuthPurpose.BIND,
        ).forEach { (provider, purpose) ->
            val encoded = json.encodeToString(
                OAuthStateRequest(
                    provider = provider,
                    purpose = purpose,
                    installationId = "11111111-1111-4111-8111-111111111111",
                ),
            )
            assertTrue(encoded.contains("\"installationId\""))
            assertFalse(encoded.contains("phoneChallengeId"))
        }
    }
}
