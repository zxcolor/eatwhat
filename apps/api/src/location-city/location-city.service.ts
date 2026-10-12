import { type LocationCityRequest, type LocationCityResponse, LocationCityResponseSchema } from "@chi-shen-me/contracts";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AmapLocationCityProvider } from "./amap-location-city.provider.js";

@Injectable()
export class LocationCityService {
	constructor(private readonly provider: AmapLocationCityProvider) {}

	async resolve(request: LocationCityRequest): Promise<LocationCityResponse> {
		try {
			return LocationCityResponseSchema.parse({ city: await this.provider.city(request.location) });
		} catch {
			// Do not surface the provider error, its URL, coordinates or credentials.
			throw new ServiceUnavailableException({
				code: "LOCATION_CITY_UNAVAILABLE", message: "城市信息暂时无法获取",
			});
		}
	}
}
