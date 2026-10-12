import { Module } from "@nestjs/common";
import { AMAP_LOCATION_CITY_FETCH, AmapLocationCityProvider } from "./amap-location-city.provider.js";
import { LocationCityController } from "./location-city.controller.js";
import { LocationCityService } from "./location-city.service.js";

@Module({
	controllers: [LocationCityController],
	providers: [LocationCityService, AmapLocationCityProvider, {
		provide: AMAP_LOCATION_CITY_FETCH, useValue: globalThis.fetch.bind(globalThis),
	}],
})
export class LocationCityModule {}
