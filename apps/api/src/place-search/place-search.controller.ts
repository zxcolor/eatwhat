import {
	type PlaceSearchRequest,
	PlaceSearchRequestSchema,
	type PlaceSearchResponse,
} from "@chi-shen-me/contracts";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { PlaceSearchService } from "./place-search.service.js";

@Controller("v1/place-search")
export class PlaceSearchController {
	constructor(private readonly places: PlaceSearchService) {}

	@Post()
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.OK)
	search(
		@Body(new ZodBodyPipe(PlaceSearchRequestSchema))
		request: PlaceSearchRequest,
	): Promise<PlaceSearchResponse> {
		return this.places.search(request);
	}
}
