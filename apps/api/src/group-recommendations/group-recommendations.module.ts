import { Module } from "@nestjs/common";
import { RecommendationsModule } from "../recommendations/recommendations.module.js";
import { GroupRecommendationsController } from "./group-recommendations.controller.js";
import { GroupRecommendationsService } from "./group-recommendations.service.js";

@Module({
	imports: [RecommendationsModule],
	controllers: [GroupRecommendationsController],
	providers: [GroupRecommendationsService],
})
export class GroupRecommendationsModule {}
