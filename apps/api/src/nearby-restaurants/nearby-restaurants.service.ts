import {
	type NearbyRestaurantRequest,
	type NearbyRestaurantResponse,
	NearbyRestaurantResponseSchema,
} from "@chi-shen-me/contracts";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { PLACE_PROVIDER, type PlaceProvider } from "../recommendations/domain/place-candidate.js";
import { haversineDistanceMetersUnrounded, toGcj02 } from "../recommendations/domain/geo.js";
import { AmapPlaceProvider } from "../recommendations/providers/amap-place.provider.js";

@Injectable()
export class NearbyRestaurantsService {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(PLACE_PROVIDER) private readonly provider: PlaceProvider,
		private readonly amap: AmapPlaceProvider,
	) {}

	get enabled(): boolean {
		// Owner-confirmed device-local storage right does not grant ranking,
		// model, favorites, or server-side persistence rights.
		return this.config.nearbyRestaurantCollectionEnabled !== false &&
			this.provider.kind === "AMAP" && this.config.amap.enabled;
	}

	async collect(request: NearbyRestaurantRequest): Promise<NearbyRestaurantResponse> {
		if (!this.enabled) throw new ServiceUnavailableException({
			code: "NEARBY_COLLECTION_DISABLED", message: "附近餐厅收集暂未开启",
		});
		try {
			const origin = toGcj02(request.location);
			const result = await this.amap.searchNearbyPage(request.location, request.page);
			const seen = new Set<string>();
			const restaurants = result.candidates.filter((place) => {
				if (place.blocked || seen.has(place.providerPlaceId) ||
					haversineDistanceMetersUnrounded(origin, place.location) > 3500) return false;
				seen.add(place.providerPlaceId);
				return true;
			}).map((place) => ({
				provider: place.provider, providerPlaceId: place.providerPlaceId,
				name: place.name, address: place.address, location: place.location,
				sourceRating: place.sourceRating, averageCostYuan: place.averageCostYuan,
				openStatus: place.openStatus, tags: [...place.tags], phone: place.phone,
				sourceAttribution: place.sourceAttribution, dataMode: place.dataMode,
			}));
			return NearbyRestaurantResponseSchema.parse({
				radiusMeters: 3500, retentionDays: 90, page: request.page,
				nextPage: result.hasMore && request.page === 1 ? 2 : null,
				truncated: result.hasMore && request.page === 2, restaurants,
			});
		} catch {
			throw new ServiceUnavailableException({
				code: "NEARBY_PROVIDER_UNAVAILABLE", message: "附近餐厅数据暂时无法获取，请稍后重试",
			});
		}
	}
}
