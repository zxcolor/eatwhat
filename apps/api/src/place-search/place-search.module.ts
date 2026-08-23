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
import {
	PLACE_KEYWORD_SEARCH_PROVIDER,
	type PlaceKeywordSearchProvider,
} from "./place-keyword-search.provider.js";
import { PlaceSearchController } from "./place-search.controller.js";
import { PlaceSearchService } from "./place-search.service.js";
import {
	AMAP_PLACE_KEYWORD_SEARCH_FETCH,
	AmapPlaceKeywordSearchProvider,
} from "./providers/amap-place-keyword-search.provider.js";
import { DemoPlaceKeywordSearchProvider } from "./providers/demo-place-keyword-search.provider.js";
import { UnavailablePlaceKeywordSearchProvider } from "./providers/unavailable-place-keyword-search.provider.js";

@Module({
	controllers: [PlaceSearchController],
	providers: [
		PlaceSearchService,
		AmapPlaceKeywordSearchProvider,
		DemoPlaceKeywordSearchProvider,
		UnavailablePlaceKeywordSearchProvider,
		{
			provide: AMAP_PLACE_KEYWORD_SEARCH_FETCH,
			useValue: globalThis.fetch.bind(globalThis),
		},
		{
			provide: PLACE_KEYWORD_SEARCH_PROVIDER,
			inject: [
				APP_CONFIG,
				AmapPlaceKeywordSearchProvider,
				DemoPlaceKeywordSearchProvider,
				UnavailablePlaceKeywordSearchProvider,
			],
			useFactory: (
				config: AppConfig,
				amap: AmapPlaceKeywordSearchProvider,
				demo: DemoPlaceKeywordSearchProvider,
				unavailable: UnavailablePlaceKeywordSearchProvider,
			): PlaceKeywordSearchProvider => {
				const capability = ProviderCapability.PLACE_KEYWORD_SEARCH;
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
					(adapter: PlaceKeywordSearchProvider) => adapter.dataSource,
				);
				return (
					new ProviderSelector(registry).select(
						config.placeSearchProviderPriority,
						capability,
					).adapter ?? unavailable
				);
			},
		},
	],
	exports: [PLACE_KEYWORD_SEARCH_PROVIDER],
})
export class PlaceSearchModule {}
