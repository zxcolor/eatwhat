import { Module } from "@nestjs/common";
import { CanteenDecisionController } from "./canteen-decision.controller.js";
import {
	CanteenDecisionService,
	MIMO_FETCH,
} from "./canteen-decision.service.js";
import {
	CANTEEN_MIMO_CONFIG,
	loadCanteenMimoConfig,
} from "./canteen-mimo.config.js";

@Module({
	controllers: [CanteenDecisionController],
	providers: [
		CanteenDecisionService,
		{ provide: CANTEEN_MIMO_CONFIG, useFactory: () => loadCanteenMimoConfig() },
		{ provide: MIMO_FETCH, useValue: globalThis.fetch.bind(globalThis) },
	],
})
export class CanteenDecisionModule {}
