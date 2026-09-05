package com.chishenme.app.domain

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.CoordinateReferenceSystem
import com.chishenme.app.data.remote.GroupRecommendationRequest
import com.chishenme.app.data.remote.TravelMode
import com.chishenme.app.di.strictGroupRecommendationJson
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GroupDecisionTest {
    private val location = Coordinate(
        latitude = 39.9,
        longitude = 116.4,
        accuracyMeters = null,
        crs = CoordinateReferenceSystem.WGS84,
    )

    @Test
    fun `validator accepts only two through eight anonymous members`() {
        for (count in 2..8) {
            assertEquals(
                GroupInputValidation.Valid,
                GroupDecisionInputValidator.validate(
                    GroupDecisionInput(location = location, members = List(count) { member() }),
                ),
            )
        }
        for (count in listOf(1, 9)) {
            assertTrue(
                GroupDecisionInputValidator.validate(
                    GroupDecisionInput(location = location, members = List(count) { member() }),
                ) is GroupInputValidation.Invalid,
            )
        }
    }

    @Test
    fun `validator rejects invalid bounds unknown cuisines and member overlap`() {
        val invalidMembers = listOf(
            member(budget = 0),
            member(minutes = 14),
            member(radius = 10_001),
            member(preferred = setOf("未知菜系")),
            member(preferred = setOf("面食"), excluded = setOf("面食")),
        )
        invalidMembers.forEach { invalid ->
            assertTrue(
                GroupDecisionInputValidator.validate(
                    GroupDecisionInput(location = location, members = listOf(invalid, member())),
                ) is GroupInputValidation.Invalid,
            )
        }
    }

    @Test
    fun `aggregation takes minima unions exclusions and intersects nonempty preferences`() {
        val result = GroupConstraintAggregator.aggregate(
            listOf(
                member(
                    budget = null,
                    minutes = 90,
                    radius = 2_000,
                    preferred = setOf("素食", "火锅", "面食", "米饭"),
                    excluded = setOf("西餐"),
                ),
                member(
                    budget = 60,
                    minutes = 45,
                    radius = 800,
                    preferred = emptySet(),
                ),
                member(
                    budget = 35,
                    minutes = 70,
                    radius = 1_200,
                    preferred = setOf("米饭", "面食", "火锅"),
                    excluded = setOf("火锅", "清真"),
                ),
            ),
        )

        assertEquals("group-constraints-v1", result.version)
        assertEquals(3, result.memberCount)
        assertEquals(35, result.effectiveBudgetMaxYuan)
        assertEquals(45, result.effectiveAvailableMinutes)
        assertEquals(800, result.effectiveRadiusMeters)
        assertEquals(listOf("面食", "米饭"), result.preferredCuisines)
        assertEquals(listOf("火锅", "清真", "西餐"), result.excludedCuisines)
        assertNull(GroupConstraintAggregator.aggregate(listOf(member(), member())).effectiveBudgetMaxYuan)
    }

    @Test
    fun `aggregation is invariant to member permutation and cuisine input order`() {
        val members = listOf(
            member(budget = 80, preferred = linkedSetOf("米饭", "中式快餐", "面食")),
            member(budget = null, minutes = 40, preferred = linkedSetOf("面食", "米饭")),
            member(
                budget = 45,
                radius = 700,
                preferred = linkedSetOf("米饭", "面食"),
                excluded = setOf("米饭"),
            ),
        )
        val canonical = GroupConstraintAggregator.aggregate(members)
        permutations(members).forEach { permutation ->
            assertEquals(canonical, GroupConstraintAggregator.aggregate(permutation))
        }
        assertEquals(listOf("面食"), canonical.preferredCuisines)
    }

    @Test
    fun `request factory emits exact identity-free shape and required null budget`() {
        val request = GroupRecommendationRequestFactory.create(
            GroupDecisionInput(
                location = location,
                travelMode = TravelMode.TRANSIT,
                members = listOf(
                    member(),
                    member(budget = 50, preferred = linkedSetOf("米饭", "面食")),
                ),
            ),
        )
        val json = strictGroupRecommendationJson(
            Json {
                ignoreUnknownKeys = true
                explicitNulls = false
                encodeDefaults = true
            },
        )
        val encoded = json.parseToJsonElement(json.encodeToString(request)).jsonObject

        assertEquals(setOf("location", "travelMode", "members"), encoded.keys)
        assertEquals(
            setOf("latitude", "longitude", "crs"),
            encoded.getValue("location").jsonObject.keys,
        )
        val firstMember = encoded.getValue("members").jsonArray.first().jsonObject
        assertEquals(
            setOf(
                "budgetMaxYuan",
                "availableMinutes",
                "radiusMeters",
                "preferredCuisines",
                "excludedCuisines",
            ),
            firstMember.keys,
        )
        assertEquals(JsonNull, firstMember.getValue("budgetMaxYuan"))
        val forbidden = setOf(
            "authorization",
            "name",
            "id",
            "locationLabel",
            "memberLocation",
            "weatherContext",
            "aiAssistanceEnabled",
            "requestTime",
        )
        assertTrue(encoded.keys.none(forbidden::contains))
        assertTrue(firstMember.keys.none(forbidden::contains))
    }

    @Test
    fun `strict codec rejects missing required budget and unknown identity fields`() {
        val json = strictGroupRecommendationJson(Json { explicitNulls = false })
        val valid = """{
            "location":{"latitude":39.9,"longitude":116.4,"crs":"WGS84"},
            "travelMode":"WALK",
            "members":[
              {"budgetMaxYuan":null,"availableMinutes":60,"radiusMeters":1500,"preferredCuisines":[],"excludedCuisines":[]},
              {"budgetMaxYuan":30,"availableMinutes":60,"radiusMeters":1500,"preferredCuisines":[],"excludedCuisines":[]}
            ]
        }""".trimIndent()
        assertEquals(2, json.decodeFromString<GroupRecommendationRequest>(valid).members.size)

        assertThrows(SerializationException::class.java) {
            json.decodeFromString<GroupRecommendationRequest>(
                valid.replace("\"budgetMaxYuan\":null,", ""),
            )
        }
        assertThrows(SerializationException::class.java) {
            json.decodeFromString<GroupRecommendationRequest>(
                valid.replace(
                    "\"budgetMaxYuan\":null,",
                    "\"budgetMaxYuan\":null,\"name\":\"不允许\",",
                ),
            )
        }
        assertFalse(json.configuration.ignoreUnknownKeys)
    }

    private fun member(
        budget: Int? = null,
        minutes: Int = 60,
        radius: Int = 1_500,
        preferred: Set<String> = emptySet(),
        excluded: Set<String> = emptySet(),
    ) = GroupMemberConstraints(
        budgetMaxYuan = budget,
        availableMinutes = minutes,
        radiusMeters = radius,
        preferredCuisines = preferred,
        excludedCuisines = excluded,
    )

    private fun <T> permutations(items: List<T>): List<List<T>> = when (items.size) {
        0, 1 -> listOf(items)
        else -> items.flatMapIndexed { index, item ->
            permutations(items.filterIndexed { otherIndex, _ -> otherIndex != index })
                .map { listOf(item) + it }
        }
    }
}
