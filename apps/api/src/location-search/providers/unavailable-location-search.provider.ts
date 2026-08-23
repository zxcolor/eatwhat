import { Injectable } from "@nestjs/common";
import {
	type LocationSearchCandidate,
	type LocationSearchProvider,
	LocationSearchProviderUnavailableError,
} from "../location-search.provider.js";

@Injectable()
export class UnavailableLocationSearchProvider
	implements LocationSearchProvider
{
	readonly dataSource = "UNAVAILABLE" as const;
	readonly dataMode = "LIVE" as const;

	async search(_query: string): Promise<readonly LocationSearchCandidate[]> {
		throw new LocationSearchProviderUnavailableError("DISABLED");
	}
}
