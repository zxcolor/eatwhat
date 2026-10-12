import { type NearbyRestaurantRequest, NearbyRestaurantRequestSchema } from "@chi-shen-me/contracts";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { NearbyRestaurantsService } from "./nearby-restaurants.service.js";

@Controller("v1/restaurants/nearby")
export class NearbyRestaurantsController {
	constructor(private readonly restaurants: NearbyRestaurantsService) {}
	@Post()
	@RateLimit(120, 60_000)
	@HttpCode(HttpStatus.OK)
	collect(@Body(new ZodBodyPipe(NearbyRestaurantRequestSchema)) request: NearbyRestaurantRequest) {
		return this.restaurants.collect(request);
	}
}
