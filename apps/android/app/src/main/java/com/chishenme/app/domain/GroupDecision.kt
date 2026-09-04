package com.chishenme.app.domain

import com.chishenme.app.data.remote.Coordinate
import com.chishenme.app.data.remote.GroupConstraintAggregation
import com.chishenme.app.data.remote.GroupRecommendationMemberConstraints
import com.chishenme.app.data.remote.GroupRecommendationRequest
import com.chishenme.app.data.remote.TravelMode

/**
 * The complete closed vocabulary accepted by the shared group contract.
 * Its order is also the canonical order used in aggregation echoes.
 */
object GroupCuisinePolicy {
    val orderedValues: List<String> = listOf(
        "中式快餐",
        "面食",
        "米饭",
        "火锅",
        "川湘菜",
        "清真",
        "素食",
        "西餐",
    )

    private val values = orderedValues.toSet()

    fun contains(value: String): Boolean = value in values

    fun canonical(values: Set<String>): List<String> = orderedValues.filter(values::contains)
}

/** Anonymous, positional member input. It deliberately has no identity or free-text field. */
data class GroupMemberConstraints(
    val budgetMaxYuan: Int? = null,
    val availableMinutes: Int = 60,
    val radiusMeters: Int = 1_500,
    val preferredCuisines: Set<String> = emptySet(),
    val excludedCuisines: Set<String> = emptySet(),
)

/** Entirely process-memory state: one shared coordinate and no per-member location. */
data class GroupDecisionInput(
    val location: Coordinate? = null,
    val travelMode: TravelMode = TravelMode.WALK,
    val members: List<GroupMemberConstraints> = List(2) { GroupMemberConstraints() },
)

sealed interface GroupInputValidation {
    data object Valid : GroupInputValidation
    data class Invalid(val message: String) : GroupInputValidation
}

object GroupDecisionInputValidator {
    fun validate(input: GroupDecisionInput): GroupInputValidation {
        val location = input.location
            ?: return GroupInputValidation.Invalid("请先选择所有成员共同的出发地点")
        if (!location.latitude.isFinite() || location.latitude !in -90.0..90.0 ||
            !location.longitude.isFinite() || location.longitude !in -180.0..180.0 ||
            location.accuracyMeters?.let {
                !it.isFinite() || it < 0.0 || it > MAX_COORDINATE_ACCURACY_METERS
            } == true
        ) {
            return GroupInputValidation.Invalid("共同出发地点无效，请重新选择")
        }
        if (input.members.size !in MIN_MEMBERS..MAX_MEMBERS) {
            return GroupInputValidation.Invalid("同设备群组需有 2–8 位成员")
        }
        input.members.forEachIndexed { index, member ->
            val ordinal = index + 1
            if (member.budgetMaxYuan != null && member.budgetMaxYuan !in 1..2_000) {
                return GroupInputValidation.Invalid("第 $ordinal 位成员的人均预算需在 1–2000 元之间")
            }
            if (member.availableMinutes !in 15..240) {
                return GroupInputValidation.Invalid("第 $ordinal 位成员的可用时间需在 15–240 分钟之间")
            }
            if (member.radiusMeters !in 200..10_000) {
                return GroupInputValidation.Invalid("第 $ordinal 位成员的最远距离需在 200 米–10 公里之间")
            }
            if (member.preferredCuisines.size > MAX_CUISINES_PER_KIND ||
                member.excludedCuisines.size > MAX_CUISINES_PER_KIND
            ) {
                return GroupInputValidation.Invalid("第 $ordinal 位成员的偏好和排除菜系最多各 8 项")
            }
            if ((member.preferredCuisines + member.excludedCuisines).any {
                    !GroupCuisinePolicy.contains(it)
                }
            ) {
                return GroupInputValidation.Invalid("第 $ordinal 位成员包含无法识别的菜系")
            }
            if (member.preferredCuisines.any(member.excludedCuisines::contains)) {
                return GroupInputValidation.Invalid("第 $ordinal 位成员不能同时偏好并排除同一菜系")
            }
        }
        return GroupInputValidation.Valid
    }

    private const val MAX_COORDINATE_ACCURACY_METERS = 10_000.0
    const val MIN_MEMBERS = 2
    const val MAX_MEMBERS = 8
    const val MAX_CUISINES_PER_KIND = 8
}

object GroupConstraintAggregator {
    const val VERSION = "group-constraints-v1"

    /**
     * The same deterministic calculation is performed on both sides of the wire.
     * Empty preference sets mean "no extra preference" and therefore do not erase
     * preferences explicitly shared by the other members.
     */
    fun aggregate(members: List<GroupMemberConstraints>): GroupConstraintAggregation {
        require(members.size in GroupDecisionInputValidator.MIN_MEMBERS..GroupDecisionInputValidator.MAX_MEMBERS) {
            "GROUP_MEMBER_COUNT_OUT_OF_RANGE"
        }
        val exclusions = members.flatMapTo(mutableSetOf()) { it.excludedCuisines }
        val nonEmptyPreferences = members
            .map(GroupMemberConstraints::preferredCuisines)
            .filter(Set<String>::isNotEmpty)
        val sharedPreferences = if (nonEmptyPreferences.isEmpty()) {
            emptySet()
        } else {
            nonEmptyPreferences.drop(1).fold(nonEmptyPreferences.first().toSet()) { shared, next ->
                shared.intersect(next)
            }
        }
        return GroupConstraintAggregation(
            version = VERSION,
            memberCount = members.size,
            effectiveBudgetMaxYuan = members.mapNotNull(GroupMemberConstraints::budgetMaxYuan).minOrNull(),
            effectiveAvailableMinutes = members.minOf(GroupMemberConstraints::availableMinutes),
            effectiveRadiusMeters = members.minOf(GroupMemberConstraints::radiusMeters),
            preferredCuisines = GroupCuisinePolicy.canonical(sharedPreferences - exclusions),
            excludedCuisines = GroupCuisinePolicy.canonical(exclusions),
        )
    }
}

object GroupRecommendationRequestFactory {
    fun create(input: GroupDecisionInput): GroupRecommendationRequest {
        check(GroupDecisionInputValidator.validate(input) == GroupInputValidation.Valid) {
            "Group decision input must be validated before creating a request"
        }
        return GroupRecommendationRequest(
            location = requireNotNull(input.location),
            travelMode = input.travelMode,
            members = input.members.map { member ->
                GroupRecommendationMemberConstraints(
                    budgetMaxYuan = member.budgetMaxYuan,
                    availableMinutes = member.availableMinutes,
                    radiusMeters = member.radiusMeters,
                    preferredCuisines = GroupCuisinePolicy.canonical(member.preferredCuisines),
                    excludedCuisines = GroupCuisinePolicy.canonical(member.excludedCuisines),
                )
            },
        )
    }
}
