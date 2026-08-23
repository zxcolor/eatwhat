import { randomUUID } from "node:crypto";
import {
	type LocationSearchRequest,
	type LocationSearchResponse,
	LocationSearchResponseSchema,
} from "@chi-shen-me/contracts";
import {
	Inject,
	Injectable,
	ServiceUnavailableException,
} from "@nestjs/common";
import {
	LOCATION_SEARCH_PROVIDER,
	type LocationSearchProvider,
} from "./location-search.provider.js";

@Injectable()
export class LocationSearchService {
	constructor(
		@Inject(LOCATION_SEARCH_PROVIDER)
		private readonly provider: LocationSearchProvider,
	) {}

	async search(
		request: LocationSearchRequest,
	): Promise<LocationSearchResponse> {
		try {
			// This is deliberately a live, user-initiated lookup. Neither the query,
			// supplier identifiers nor returned coordinates are retained here.
			const results = await this.provider.search(request.query);
			return LocationSearchResponseSchema.parse({
				requestId: randomUUID(),
				dataSource: this.provider.dataSource,
				dataMode: this.provider.dataMode,
				results: results.slice(0, 5),
			});
		} catch {
			throw new ServiceUnavailableException({
				code: "LOCATION_PROVIDER_UNAVAILABLE",
				message: "地点数据服务暂时不可用，请稍后重试",
			});
		}
	}
}
