import { Module } from "@nestjs/common";
import { NearbyRestaurantsModule } from "./nearby-restaurants/nearby-restaurants.module.js";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module.js";
import { CommonSecurityModule } from "./common/common-security.module.js";
import { IpRateLimitGuard } from "./common/ip-rate-limit.guard.js";
import { AppConfigModule } from "./config/app-config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { RecommendationEventsModule } from "./events/recommendation-events.module.js";
import { FavoritesModule } from "./favorites/favorites.module.js";
import { FeatureConfigModule } from "./feature-config/feature-config.module.js";
import { HealthModule } from "./health/health.module.js";
import { LocationSearchModule } from "./location-search/location-search.module.js";
import { LocationCityModule } from "./location-city/location-city.module.js";
import { OperationalConfigModule } from "./operational-config/operational-config.module.js";
import { PlaceSearchModule } from "./place-search/place-search.module.js";
import { PrivateFeedbackModule } from "./private-feedback/private-feedback.module.js";
import { RecommendationsModule } from "./recommendations/recommendations.module.js";
import { SupportFeedbackModule } from "./support-feedback/support-feedback.module.js";

@Module({
	imports: [
		NearbyRestaurantsModule,
		CommonSecurityModule,
		AppConfigModule,
		DatabaseModule,
		OperationalConfigModule,
		AuthModule,
		HealthModule,
		FeatureConfigModule,
		FavoritesModule,
		LocationSearchModule,
		LocationCityModule,
		PlaceSearchModule,
		RecommendationsModule,
		RecommendationEventsModule,
		PrivateFeedbackModule,
		SupportFeedbackModule,
	],
	providers: [{ provide: APP_GUARD, useClass: IpRateLimitGuard }],
})
export class AppModule {}
