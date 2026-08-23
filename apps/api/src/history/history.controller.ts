import {
	type ListRecommendationHistoryQuery,
	ListRecommendationHistoryQuerySchema,
} from "@chi-shen-me/contracts";
import {
	Controller,
	Delete,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Query,
} from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { HistoryService } from "./history.service.js";

@Controller("v1/history")
export class HistoryController {
	constructor(private readonly history: HistoryService) {}

	@Get()
	@RateLimit(60, 60_000)
	list(
		@Headers("authorization") authorization: string | undefined,
		@Query(new ZodBodyPipe(ListRecommendationHistoryQuerySchema))
		query: ListRecommendationHistoryQuery,
	) {
		return this.history.list(authorization, query);
	}

	@Delete()
	@RateLimit(20, 60_000)
	@HttpCode(HttpStatus.NO_CONTENT)
	async clear(
		@Headers("authorization") authorization: string | undefined,
	): Promise<void> {
		await this.history.clear(authorization);
	}
}
