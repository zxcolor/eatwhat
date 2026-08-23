import { Global, Module } from "@nestjs/common";
import { RecommendationRequestRegistry } from "./recommendation-request.registry.js";

@Global()
@Module({
	providers: [RecommendationRequestRegistry],
	exports: [RecommendationRequestRegistry],
})
export class CommonSecurityModule {}
