import { Module } from "@nestjs/common";
import { RecommendationsModule } from "../recommendations/recommendations.module.js";
import { NearbyRestaurantsController } from "./nearby-restaurants.controller.js";
import { NearbyRestaurantsService } from "./nearby-restaurants.service.js";

@Module({
	imports: [RecommendationsModule],
	controllers: [NearbyRestaurantsController],
	providers: [NearbyRestaurantsService],
	exports: [NearbyRestaurantsService],
})
export class NearbyRestaurantsModule {}
