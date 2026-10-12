package com.chishenme.app

import android.Manifest
import android.content.Context
import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import com.chishenme.app.data.NearbyRestaurantsRepository
import com.chishenme.app.data.local.NearbyRestaurantCache
import com.chishenme.app.data.local.NearbyRestaurantSnapshot
import com.chishenme.app.data.local.ThemePreference
import com.chishenme.app.data.remote.*
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import com.chishenme.app.feature.nearby.*
import com.chishenme.app.location.*
import com.chishenme.app.ui.theme.ChiShenMeTheme
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith

/** Uses synthetic restaurants and injected location results on an isolated fixture device. */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalSerializationApi::class)
class NearbyRestaurantCollectionTest {
    @get:Rule val compose = createComposeRule()
    @get:Rule val permission = GrantPermissionRule.grant(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = true; explicitNulls = false }
    private val cache = NearbyRestaurantCache(context, json)
    private val gate = object : PrivacyAuthorizationGate {
        var accepted = true
        override suspend fun isAccepted() = accepted
        override fun revoke() { accepted = false }
        override fun allowAfterDurableAcceptance(): Boolean { accepted = true; return true }
    }
    private val coordinate = Coordinate(0.0, 0.0, crs = CoordinateReferenceSystem.WGS84)
    private fun place(id: String, name: String = id) = NearbyRestaurant(
        "AMAP", id, name, "合成测试地址", NearbyRestaurantCoordinate(0.0, 0.0, CoordinateReferenceSystem.WGS84), null, null,
        OpenStatus.UNKNOWN, emptyList(), null, "合成测试夹具", RecommendationDataMode.LIVE,
    )
    @Before fun reset() = runBlocking { cache.clear(); gate.accepted = true }
    @After fun clear() = runBlocking { cache.clear() }

    @Test fun timestampFilesNeverMergeAndExpiredFilesArePhysicallyDeleted() = runBlocking {
        val now = System.currentTimeMillis()
        val firstLocation = coordinate.copy(accuracyMeters = 7.5)
        val secondLocation = coordinate.copy(longitude = 0.001, accuracyMeters = 45.0)
        val first = cache.create(now - 1000, firstLocation)
        cache.append(first, listOf(place("same", "第一次")), 1)
        cache.append(first, listOf(place("same", "第一次更新")), 2)
        cache.finish(first, true)
        val second = cache.create(now, secondLocation)
        cache.append(second, listOf(place("same", "第二次")), 1)
        cache.finish(second, true)
        val snapshots = cache.snapshots()
        assertEquals(2, snapshots.size)
        assertEquals("第二次", snapshots[0].restaurants.single().name)
        assertEquals("第一次更新", snapshots[1].restaurants.single().name)
        assertEquals(secondLocation, snapshots[0].userLocation)
        assertEquals(firstLocation, snapshots[1].userLocation)
        val root = File(context.filesDir, "nearby_restaurants")
        assertTrue(root.listFiles().orEmpty().all { it.isFile && it.name.matches(Regex("[0-9]+\\.json")) })
        assertTrue(File(root, "$first.json").exists())
        assertTrue(File(root, "$second.json").exists())
        val collision = cache.create(now, coordinate)
        assertNotEquals(second, collision)
        cache.append(collision, listOf(place("same", "同毫秒另一启动")), 1)
        cache.finish(collision, true)
        assertEquals(setOf("第一次更新", "第二次", "同毫秒另一启动"), cache.snapshots().map { it.restaurants.single().name }.toSet())
        val expired = now - 91L * 24 * 60 * 60 * 1000
        val expiredFile = File(root, "$expired.json")
        expiredFile.writeText(json.encodeToString(NearbyRestaurantSnapshot(expired, expired, restaurants = listOf(place("expired")))))
        assertEquals(3, cache.snapshots().size)
        assertFalse(expiredFile.exists())
        assertTrue(File(root, "$first.json").readText().contains("\"accuracyMeters\":7.5"))
        assertTrue(File(root, "$collision.json").readText().contains("\"accuracyMeters\":null"))
    }

    @Test fun successfulStartupRequestsExactlyTwoPagesAndSavesOneFile() {
        val requests = mutableListOf<Int>()
        val api = object : NearbyRestaurantsApi {
            override suspend fun collect(request: NearbyRestaurantRequest): NearbyRestaurantResponse {
                requests += request.page
                return NearbyRestaurantResponse(3500, 90, request.page, if (request.page == 1) 2 else null,
                    request.page == 2, (0..24).map { place(if (request.page == 2 && it == 0) "1-0" else "${request.page}-$it") })
            }
        }
        val client = object : ForegroundLocationClient {
            override suspend fun currentLocation() = ForegroundLocationResult.Success(
                LocationFix(0.0, 0.0, 15.0, CoordinateReferenceSystem.WGS84), LocationAccess.PRECISE,
            )
        }
        val vm = NearbyCollectionViewModel(client, NearbyRestaurantsRepository(api, cache, gate), gate, cache)
        compose.setContent {
            ChiShenMeTheme(themePreference = ThemePreference.LIGHT) {
                StartupNearbyCollection(vm, true, System.currentTimeMillis()) {}
                Text("测试首页")
            }
        }
        compose.waitUntil(15000) { vm.state.value.phase == NearbyPhase.DONE }
        assertEquals(listOf(1, 2), requests)
        assertEquals(49, vm.state.value.count)
        val snapshot = runBlocking { cache.snapshots().single() }
        assertEquals(49, snapshot.restaurants.size)
        assertEquals(2, snapshot.pagesCollected)
        assertEquals("COMPLETE", snapshot.status)
        assertTrue(snapshot.limited)
        assertEquals(Coordinate(0.0, 0.0, accuracyMeters = 15.0, crs = CoordinateReferenceSystem.WGS84), snapshot.userLocation)
        vm.stop()
    }

    @Test fun sixFailedAttemptsShowOneReminderAndSaveNoRestaurantFile() {
        var attempts = 0
        val api = object : NearbyRestaurantsApi {
            override suspend fun collect(request: NearbyRestaurantRequest): NearbyRestaurantResponse = error("No restaurant request after failed location")
        }
        val client = object : ForegroundLocationClient {
            override suspend fun currentLocation(): ForegroundLocationResult {
                attempts++
                return ForegroundLocationResult.Failure(LocationFailure.TIMEOUT)
            }
        }
        val vm = NearbyCollectionViewModel(client, NearbyRestaurantsRepository(api, cache, gate), gate, cache)
        compose.setContent {
            ChiShenMeTheme(themePreference = ThemePreference.LIGHT) {
                StartupNearbyCollection(vm, true, System.currentTimeMillis()) {}
                Text("测试首页")
            }
        }
        compose.waitUntil(15000) { vm.state.value.phase == NearbyPhase.FAILED }
        compose.onNodeWithText("定位提醒").assertIsDisplayed()
        compose.onNodeWithText("首次定位及 5 次重试均未成功。", substring = true).assertIsDisplayed()
        assertEquals(6, attempts)
        assertTrue(runBlocking { cache.snapshots().isEmpty() })
        vm.stop()
    }

    @Test fun withdrawingDuringPageTwoDoesNotCommitOrResurrectDeletedData() = runBlocking {
        val requests = mutableListOf<Int>()
        val api = object : NearbyRestaurantsApi {
            override suspend fun collect(request: NearbyRestaurantRequest): NearbyRestaurantResponse {
                requests += request.page
                if (request.page == 2) { gate.revoke(); cache.clear() }
                return NearbyRestaurantResponse(3500, 90, request.page, if (request.page == 1) 2 else null,
                    false, listOf(place("${request.page}")))
            }
        }
        val result = runCatching { NearbyRestaurantsRepository(api, cache, gate).collect(coordinate, System.currentTimeMillis()) {} }
        assertTrue(result.isFailure)
        assertEquals(listOf(1, 2), requests)
        assertTrue(cache.snapshots().isEmpty())
    }
}
