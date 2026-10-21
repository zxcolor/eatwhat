import {
	CanteenDecisionRequestSchema,
	type CanteenDecisionRequest,
	type CanteenDecisionResponse,
} from "@chi-shen-me/contracts";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { CanteenDecisionService } from "./canteen-decision.service.js";

@Controller("v1/canteen/decisions")
export class CanteenDecisionController {
	constructor(private readonly decisions: CanteenDecisionService) {}
	@Post()
	@RateLimit(12, 60_000)
	@HttpCode(HttpStatus.OK)
	decide(
		@Body(new ZodBodyPipe(CanteenDecisionRequestSchema))
		request: CanteenDecisionRequest,
	): Promise<CanteenDecisionResponse> {
		return this.decisions.decide(request);
	}
}
