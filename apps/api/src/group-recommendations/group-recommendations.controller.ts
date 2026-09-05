import {
	type GroupRecommendationRequest,
	GroupRecommendationRequestSchema,
	type GroupRecommendationResponse,
} from "@chi-shen-me/contracts";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { GroupRecommendationsService } from "./group-recommendations.service.js";

@Controller("v1/group-recommendations")
export class GroupRecommendationsController {
	constructor(
		private readonly groupRecommendations: GroupRecommendationsService,
	) {}

	@Post()
	@RateLimit(10, 60_000)
	@HttpCode(HttpStatus.OK)
	recommend(
		@Body(new ZodBodyPipe(GroupRecommendationRequestSchema))
		request: GroupRecommendationRequest,
	): Promise<GroupRecommendationResponse> {
		return this.groupRecommendations.recommend(request);
	}
}
