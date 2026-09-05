import type { RecommendationContext } from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import type {
	PlaceCandidate,
	PlaceProvider,
} from "../domain/place-candidate.js";
import type { RecommendationQueryPlan } from "../domain/recommendation-query-plan.js";

@Injectable()
export class UnavailablePlaceProvider implements PlaceProvider {
	readonly kind = "UNAVAILABLE" as const;
	readonly dataMode = "LIVE" as const;

	supportsQueryPlan(plan: RecommendationQueryPlan): boolean {
		// This reports whether the adapter understands the query shape, not whether
		// a live upstream is configured. Keeping ordinary meal plans supported
		// preserves their existing provider-unavailable path, while new capability
		// or weather plans still fail before intent resolution.
		return (
			!plan.providerCapabilityRequired &&
			!plan.profile.providerCapabilityRequired &&
			plan.profile.target === "MEAL" &&
			(plan.profile.version === "meal-breakfast-v1" ||
				plan.profile.version === "meal-lunch-v1" ||
				plan.profile.version === "meal-dinner-v1") &&
			plan.weatherApplication.kind === "NONE" &&
			plan.weatherApplication.version === "weather-none-v1"
		);
	}

	async search(
		_context: RecommendationContext,
		_plan: RecommendationQueryPlan,
	): Promise<readonly PlaceCandidate[]> {
		throw new Error("No licensed place provider is enabled");
	}
}
