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
	PLACE_PROVIDER,
	type PlaceProvider,
} from "./domain/place-candidate.js";
import {
	AMAP_FETCH,
	AmapPlaceProvider,
} from "./providers/amap-place.provider.js";
import { DemoPlaceProvider } from "./providers/demo-place.provider.js";
import { IntentCoordinator } from "./providers/intent-coordinator.js";
import {
	QWEN_FETCH,
	QwenIntentProvider,
} from "./providers/qwen-intent.provider.js";
import { RuleIntentProvider } from "./providers/rule-intent.provider.js";
import { UnavailablePlaceProvider } from "./providers/unavailable-place.provider.js";
import { RecommendationsController } from "./recommendations.controller.js";
import { RecommendationsService } from "./recommendations.service.js";

@Module({
	controllers: [RecommendationsController],
	providers: [
		RecommendationsService,
		RuleIntentProvider,
		QwenIntentProvider,
		IntentCoordinator,
		DemoPlaceProvider,
		AmapPlaceProvider,
		UnavailablePlaceProvider,
		{ provide: QWEN_FETCH, useValue: globalThis.fetch.bind(globalThis) },
		{ provide: AMAP_FETCH, useValue: globalThis.fetch.bind(globalThis) },
		{
			provide: PLACE_PROVIDER,
			inject: [
				APP_CONFIG,
				DemoPlaceProvider,
				AmapPlaceProvider,
				UnavailablePlaceProvider,
			],
			useFactory: (
				config: AppConfig,
				demo: DemoPlaceProvider,
				amap: AmapPlaceProvider,
				unavailable: UnavailablePlaceProvider,
			): PlaceProvider => {
				const capability = ProviderCapability.PLACE_RECOMMENDATION;
				assertCatalogCapability(amap.kind, capability);
				assertCatalogCapability(demo.kind, capability);
				const registry = new ProviderRegistry(
					[
						{
							descriptor: providerDescriptor(
								amap.kind,
								[capability],
								config.amap.enabled,
							),
							adapter: amap,
						},
						{
							descriptor: providerDescriptor(
								demo.kind,
								[capability],
								config.demoDataAllowed,
							),
							adapter: demo,
						},
					],
					(adapter: PlaceProvider) => adapter.kind,
				);
				return (
					new ProviderSelector(registry).select(
						config.recommendationProviderPriority,
						capability,
					).adapter ?? unavailable
				);
			},
		},
	],
	exports: [PLACE_PROVIDER],
})
export class RecommendationsModule {}
