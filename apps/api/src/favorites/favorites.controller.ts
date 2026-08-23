import {
	type FavoriteIdPath,
	FavoriteIdPathSchema,
	type FavoriteMutationRequest,
	FavoriteMutationRequestSchema,
	type ListFavoritesQuery,
	ListFavoritesQuerySchema,
	type UpdateFavoriteGroupRequest,
	UpdateFavoriteGroupRequestSchema,
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
import { FavoritesService } from "./favorites.service.js";

@Controller("v1/favorites")
export class FavoritesController {
	constructor(private readonly favorites: FavoritesService) {}

	@Get()
	@RateLimit(60, 60_000)
	list(
		@Headers("authorization") authorization: string | undefined,
		@Query(new ZodBodyPipe(ListFavoritesQuerySchema)) query: ListFavoritesQuery,
	) {
		return this.favorites.list(authorization, query);
	}

	@Post()
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.CREATED)
	create(
		@Headers("authorization") authorization: string | undefined,
		@Body(new ZodBodyPipe(FavoriteMutationRequestSchema))
		input: FavoriteMutationRequest,
	) {
		return this.favorites.create(authorization, input);
	}

	@Post(":favoriteId/group")
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.OK)
	updateGroup(
		@Headers("authorization") authorization: string | undefined,
		@Param(new ZodBodyPipe(FavoriteIdPathSchema)) path: FavoriteIdPath,
		@Body(new ZodBodyPipe(UpdateFavoriteGroupRequestSchema))
		input: UpdateFavoriteGroupRequest,
	) {
		return this.favorites.updateGroup(authorization, path.favoriteId, input);
	}

	@Delete(":favoriteId")
	@RateLimit(30, 60_000)
	@HttpCode(HttpStatus.NO_CONTENT)
	async delete(
		@Headers("authorization") authorization: string | undefined,
		@Param(new ZodBodyPipe(FavoriteIdPathSchema)) path: FavoriteIdPath,
	): Promise<void> {
		await this.favorites.delete(authorization, path.favoriteId);
	}
}
