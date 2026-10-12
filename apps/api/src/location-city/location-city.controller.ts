import { type LocationCityRequest, LocationCityRequestSchema } from "@chi-shen-me/contracts";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { LocationCityService } from "./location-city.service.js";

@Controller("v1/location-city")
export class LocationCityController {
	constructor(private readonly city: LocationCityService) {}

	@Post()
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.OK)
	resolve(@Body(new ZodBodyPipe(LocationCityRequestSchema)) request: LocationCityRequest) {
		return this.city.resolve(request);
	}
}
