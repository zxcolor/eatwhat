import {
	type CreatePrivateFeedbackRequest,
	CreatePrivateFeedbackRequestSchema,
	type FeedbackIdPath,
	FeedbackIdPathSchema,
	type ListPrivateFeedbackQuery,
	ListPrivateFeedbackQuerySchema,
} from "@chi-shen-me/contracts";
import {
	Body,
	Controller,
	Delete,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Param,
	Post,
	Query,
} from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { PrivateFeedbackService } from "./private-feedback.service.js";

@Controller("v1/private-feedback")
export class PrivateFeedbackController {
	constructor(private readonly feedback: PrivateFeedbackService) {}

	@Get()
	@RateLimit(60, 60_000)
	list(
		@Headers("authorization") authorization: string | undefined,
		@Query(new ZodBodyPipe(ListPrivateFeedbackQuerySchema))
		query: ListPrivateFeedbackQuery,
	) {
		return this.feedback.list(authorization, query);
	}

	@Post()
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.CREATED)
	create(
		@Headers("authorization") authorization: string | undefined,
		@Body(new ZodBodyPipe(CreatePrivateFeedbackRequestSchema))
		input: CreatePrivateFeedbackRequest,
	) {
		return this.feedback.create(authorization, input);
	}

	@Delete()
	@RateLimit(20, 60_000)
	@HttpCode(HttpStatus.NO_CONTENT)
	async clear(
		@Headers("authorization") authorization: string | undefined,
	): Promise<void> {
		await this.feedback.clear(authorization);
	}

	@Delete(":feedbackId")
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.NO_CONTENT)
	async delete(
		@Headers("authorization") authorization: string | undefined,
		@Param(new ZodBodyPipe(FeedbackIdPathSchema)) path: FeedbackIdPath,
	): Promise<void> {
		await this.feedback.delete(authorization, path.feedbackId);
	}
}
