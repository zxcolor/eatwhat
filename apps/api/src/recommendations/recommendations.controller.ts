import {
	type RecommendationContext,
	RecommendationContextSchema,
	type RecommendationResponse,
} from "@chi-shen-me/contracts";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { RecommendationsService } from "./recommendations.service.js";

@Controller("v1/recommendations")
export class RecommendationsController {
	constructor(private readonly recommendations: RecommendationsService) {}

	@Post()
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.OK)
	recommend(
		@Body(new ZodBodyPipe(RecommendationContextSchema))
		context: RecommendationContext,
	): Promise<RecommendationResponse> {
		return this.recommendations.recommend(context);
	}
}
