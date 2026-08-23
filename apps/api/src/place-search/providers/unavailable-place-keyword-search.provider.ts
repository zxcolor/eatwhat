import { Injectable } from "@nestjs/common";
import {
	type PlaceKeywordSearchCandidate,
	type PlaceKeywordSearchProvider,
	PlaceKeywordSearchProviderUnavailableError,
} from "../place-keyword-search.provider.js";

@Injectable()
export class UnavailablePlaceKeywordSearchProvider
	implements PlaceKeywordSearchProvider
{
	readonly dataSource = "UNAVAILABLE" as const;
	readonly dataMode = "LIVE" as const;

	async search(): Promise<readonly PlaceKeywordSearchCandidate[]> {
		throw new PlaceKeywordSearchProviderUnavailableError("DISABLED");
	}
}
