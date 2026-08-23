import {
	type LocationSearchRequest,
	LocationSearchRequestSchema,
	type LocationSearchResponse,
} from "@chi-shen-me/contracts";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { LocationSearchService } from "./location-search.service.js";

@Controller("v1/location-search")
export class LocationSearchController {
	constructor(private readonly locations: LocationSearchService) {}

	@Post()
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.OK)
	search(
		@Body(new ZodBodyPipe(LocationSearchRequestSchema))
		request: LocationSearchRequest,
	): Promise<LocationSearchResponse> {
		return this.locations.search(request);
	}
}
