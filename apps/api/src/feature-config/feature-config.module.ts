import { Module } from "@nestjs/common";
import { LocationSearchModule } from "../location-search/location-search.module.js";
import { PlaceSearchModule } from "../place-search/place-search.module.js";
import { RecommendationsModule } from "../recommendations/recommendations.module.js";
import { SupportFeedbackModule } from "../support-feedback/support-feedback.module.js";
import { FeatureConfigController } from "./feature-config.controller.js";
import { FeatureConfigService } from "./feature-config.service.js";

@Module({
	imports: [
		RecommendationsModule,
		LocationSearchModule,
		PlaceSearchModule,
		SupportFeedbackModule,
	],
	controllers: [FeatureConfigController],
	providers: [FeatureConfigService],
})
export class FeatureConfigModule {}
