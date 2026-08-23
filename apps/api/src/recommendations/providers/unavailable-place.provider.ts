import type { RecommendationContext } from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import type {
	PlaceCandidate,
	PlaceProvider,
} from "../domain/place-candidate.js";

@Injectable()
export class UnavailablePlaceProvider implements PlaceProvider {
	readonly kind = "UNAVAILABLE" as const;
	readonly dataMode = "LIVE" as const;

	async search(
		_context: RecommendationContext,
		_mealTypes: readonly string[],
	): Promise<readonly PlaceCandidate[]> {
		throw new Error("No licensed place provider is enabled");
	}
}
