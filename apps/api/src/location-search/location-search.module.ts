import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import {
	assertCatalogCapability,
	ProviderCapability,
} from "../providers/provider-catalog.js";
import {
	ProviderRegistry,
	ProviderSelector,
	providerDescriptor,
} from "../providers/provider-registry.js";
import { LocationSearchController } from "./location-search.controller.js";
import {
	LOCATION_SEARCH_PROVIDER,
	type LocationSearchProvider,
} from "./location-search.provider.js";
import { LocationSearchService } from "./location-search.service.js";
import {
	AMAP_LOCATION_SEARCH_FETCH,
	AmapLocationSearchProvider,
} from "./providers/amap-location-search.provider.js";
import { DemoLocationSearchProvider } from "./providers/demo-location-search.provider.js";
import { UnavailableLocationSearchProvider } from "./providers/unavailable-location-search.provider.js";

@Module({
	controllers: [LocationSearchController],
	providers: [
		LocationSearchService,
		AmapLocationSearchProvider,
		DemoLocationSearchProvider,
		UnavailableLocationSearchProvider,
		{
			provide: AMAP_LOCATION_SEARCH_FETCH,
			useValue: globalThis.fetch.bind(globalThis),
		},
		{
			provide: LOCATION_SEARCH_PROVIDER,
			inject: [
				APP_CONFIG,
				AmapLocationSearchProvider,
				DemoLocationSearchProvider,
				UnavailableLocationSearchProvider,
			],
			useFactory: (
				config: AppConfig,
				amap: AmapLocationSearchProvider,
				demo: DemoLocationSearchProvider,
				unavailable: UnavailableLocationSearchProvider,
			): LocationSearchProvider => {
				const capability = ProviderCapability.LOCATION_TEXT_SEARCH;
				assertCatalogCapability(amap.dataSource, capability);
				assertCatalogCapability(demo.dataSource, capability);
				const registry = new ProviderRegistry(
					[
						{
							descriptor: providerDescriptor(
								amap.dataSource,
								[capability],
								config.amap.enabled,
							),
							adapter: amap,
						},
						{
							descriptor: providerDescriptor(
								demo.dataSource,
								[capability],
								config.demoDataAllowed,
							),
							adapter: demo,
						},
					],
					(adapter: LocationSearchProvider) => adapter.dataSource,
				);
				return (
					new ProviderSelector(registry).select(
						config.locationSearchProviderPriority,
						capability,
					).adapter ?? unavailable
				);
			},
		},
	],
	exports: [LOCATION_SEARCH_PROVIDER],
})
export class LocationSearchModule {}
