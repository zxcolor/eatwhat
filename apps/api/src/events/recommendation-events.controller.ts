import {
	type RecommendationEvent,
	RecommendationEventSchema,
} from "@chi-shen-me/contracts";
import {
	Body,
	Controller,
	Headers,
	HttpCode,
	HttpStatus,
	Post,
} from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { RecommendationEventsService } from "./recommendation-events.service.js";

@Controller("v1/recommendation-events")
export class RecommendationEventsController {
	constructor(private readonly events: RecommendationEventsService) {}

	@Post()
	@RateLimit(180, 60_000)
	@HttpCode(HttpStatus.ACCEPTED)
	accept(
		@Body(new ZodBodyPipe(RecommendationEventSchema))
		event: RecommendationEvent,
		@Headers("authorization") authorization: string | undefined,
	): Promise<{ eventId: string; accepted: true }> {
		return this.events.accept(event, authorization);
	}
}
