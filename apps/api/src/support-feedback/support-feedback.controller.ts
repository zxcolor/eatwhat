import {
	type SupportFeedbackRequest,
	SupportFeedbackRequestSchema,
	type SupportFeedbackResponse,
} from "@chi-shen-me/contracts";
import {
	Body,
	Controller,
	Headers,
	HttpCode,
	HttpStatus,
	Ip,
	Post,
} from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { SupportFeedbackService } from "./support-feedback.service.js";

@Controller("v1/support-feedback")
export class SupportFeedbackController {
	constructor(private readonly supportFeedback: SupportFeedbackService) {}

	@Post()
	@RateLimit(10, 60_000)
	@HttpCode(HttpStatus.ACCEPTED)
	submit(
		@Body(new ZodBodyPipe(SupportFeedbackRequestSchema))
		input: SupportFeedbackRequest,
		@Headers("authorization") authorization: string | undefined,
		@Ip() clientIp: string,
	): Promise<SupportFeedbackResponse> {
		return this.supportFeedback.submit(input, authorization, clientIp);
	}
}
