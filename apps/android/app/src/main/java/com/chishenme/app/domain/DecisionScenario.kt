package com.chishenme.app.domain

import com.chishenme.app.data.remote.DecisionMode
import com.chishenme.app.data.remote.ExplorationMode
import com.chishenme.app.data.remote.MealPeriod
import com.chishenme.app.data.remote.TravelMode

/**
 * App-owned, deterministic shortcuts for common decision contexts.
 *
 * A scenario only changes fields that the user can already edit on the home
 * screen. Location and cuisine choices deliberately survive applying a
 * scenario so the shortcut cannot silently broaden where data is sent or undo
 * an explicit food constraint.
 */
enum class DecisionScenario {
    IN_A_HURRY,
    WORKDAY_LUNCH,
    FRIENDS_GATHERING,
    BUSINESS_TRIP,
}

fun DecisionInput.applyScenario(scenario: DecisionScenario): DecisionInput = when (scenario) {
    DecisionScenario.IN_A_HURRY -> copy(
        decisionMode = DecisionMode.QUICK,
        travelMode = TravelMode.WALK,
        explorationMode = ExplorationMode.SAFE,
        budgetMaxYuan = 25,
        availableMinutes = 30,
        radiusMeters = 1_000,
        partySize = 1,
    )
    DecisionScenario.WORKDAY_LUNCH -> copy(
        mealPeriod = MealPeriod.LUNCH,
        decisionMode = DecisionMode.QUICK,
        travelMode = TravelMode.WALK,
        explorationMode = ExplorationMode.BALANCED,
        budgetMaxYuan = 25,
        availableMinutes = 45,
        radiusMeters = 1_500,
        partySize = 1,
    )
    DecisionScenario.FRIENDS_GATHERING -> copy(
        decisionMode = DecisionMode.GUIDED,
        travelMode = TravelMode.TRANSIT,
        explorationMode = ExplorationMode.ADVENTUROUS,
        budgetMaxYuan = 40,
        availableMinutes = 90,
        radiusMeters = 3_000,
        partySize = 3,
    )
    DecisionScenario.BUSINESS_TRIP -> copy(
        decisionMode = DecisionMode.GUIDED,
        travelMode = TravelMode.WALK,
        explorationMode = ExplorationMode.BALANCED,
        budgetMaxYuan = 40,
        availableMinutes = 60,
        radiusMeters = 1_500,
        partySize = 1,
    )
}
