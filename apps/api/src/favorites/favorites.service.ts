import { randomUUID } from "node:crypto";
import type {
	FavoriteMutationRequest,
	FavoriteRecord,
	FavoritesPage,
	ListFavoritesQuery,
	UpdateFavoriteGroupRequest,
} from "@chi-shen-me/contracts";
import {
	ConflictException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import type { InternalFavoriteRow } from "../persistence/persistence.repository.js";
import { PersistenceRepository } from "../persistence/persistence.repository.js";
import {
	idempotencyConflict,
	PersistenceCapabilityService,
	PersistenceCursorService,
	persistenceHash,
	persistenceUnavailable,
	resultReferenceExpired,
} from "../persistence/persistence-support.js";
import { PersistenceUserService } from "../persistence/persistence-user.service.js";
import { PlacePresentationResolver } from "../persistence/place-presentation.resolver.js";

@Injectable()
export class FavoritesService {
	constructor(
		private readonly users: PersistenceUserService,
		private readonly registry: RecommendationRequestRegistry,
		private readonly capability: PersistenceCapabilityService,
		private readonly repository: PersistenceRepository,
		private readonly cursors: PersistenceCursorService,
		private readonly presentations: PlacePresentationResolver,
	) {}

	async create(
		authorization: unknown,
		input: FavoriteMutationRequest,
	): Promise<FavoriteRecord> {
		const user = await this.users.resolve(authorization);
		const reference = this.registry.resolveForPersistence(
			input.result.requestId,
			input.result.resultToken,
			"FAVORITE",
		);
		if (reference === null) throw resultReferenceExpired();
		const grant = await this.capability.requireGrant(
			"FAVORITE",
			reference.provider,
		);
		this.requireRepository();
		try {
			const result = await this.repository.createFavorite({
				userId: user.userId,
				claim: {
					operation: "CREATE_FAVORITE",
					keyHash: persistenceHash(
						"favorite-idempotency",
						user.userId,
						input.idempotencyKey,
					),
					requestHash: persistenceHash(
						"favorite-create",
						input.result.requestId,
						input.result.resultToken,
						input.group,
					),
					proposedResourceId: randomUUID(),
				},
				reference: {
					provider: reference.provider,
					providerPlaceId: reference.providerPlaceId,
					authorizationId: grant.authorizationId,
					referenceRetainUntil: grant.retainUntil,
				},
				group: input.group,
			});
			if (result.outcome === "CONFLICT") throw idempotencyConflict();
			if (result.row === null) throw this.resourceStateConflict();
			return await this.toRecord(result.row);
		} catch (error) {
			if (error instanceof ConflictException) throw error;
			throw persistenceUnavailable();
		}
	}

	async updateGroup(
		authorization: unknown,
		favoriteId: string,
		input: UpdateFavoriteGroupRequest,
	): Promise<FavoriteRecord> {
		const user = await this.users.resolve(authorization);
		this.capability.requireDeploymentCapability("FAVORITE");
		this.requireRepository();
		try {
			const result = await this.repository.updateFavoriteGroup({
				userId: user.userId,
				favoriteId,
				claim: {
					operation: "UPDATE_FAVORITE_GROUP",
					keyHash: persistenceHash(
						"favorite-group-idempotency",
						user.userId,
						input.idempotencyKey,
					),
					requestHash: persistenceHash(
						"favorite-group-update",
						favoriteId,
						input.group,
					),
					proposedResourceId: favoriteId,
				},
				group: input.group,
			});
			if (result.outcome === "CONFLICT") throw idempotencyConflict();
			if (result.row === null) {
				throw new NotFoundException({
					code: "FAVORITE_NOT_FOUND",
					message: "收藏不存在或当前不可修改",
				});
			}
			return await this.toRecord(result.row);
		} catch (error) {
			if (
				error instanceof ConflictException ||
				error instanceof NotFoundException
			) {
				throw error;
			}
			throw persistenceUnavailable();
		}
	}

	async list(
		authorization: unknown,
		query: ListFavoritesQuery,
	): Promise<FavoritesPage> {
		const user = await this.users.resolve(authorization);
		this.requireRepository();
		const filter = query.group ?? "*";
		const boundary = this.cursors.resolve(
			query.cursor,
			user.userId,
			"FAVORITES",
			filter,
		);
		try {
			const rows = await this.repository.listFavorites(
				user.userId,
				boundary,
				query.limit + 1,
				query.group ?? null,
			);
			const retained = rows.slice(0, query.limit);
			const items = await this.toRecords(retained);
			const last = retained.at(-1);
			return Object.freeze({
				items,
				nextCursor:
					rows.length > query.limit && last !== undefined
						? this.cursors.issue(
								user.userId,
								"FAVORITES",
								filter,
								last.createdAt,
								last.favoriteId,
							)
						: null,
			});
		} catch (error) {
			if (error instanceof ConflictException) throw error;
			throw persistenceUnavailable();
		}
	}

	async delete(authorization: unknown, favoriteId: string): Promise<void> {
		const user = await this.users.resolve(authorization);
		this.requireRepository();
		try {
			await this.repository.deleteFavorite(user.userId, favoriteId);
		} catch {
			throw persistenceUnavailable();
		}
	}

	private requireRepository(): void {
		if (!this.repository.isAvailable()) throw persistenceUnavailable();
	}

	private resourceStateConflict(): ConflictException {
		return new ConflictException({
			code: "RESOURCE_STATE_CONFLICT",
			message: "首次幂等请求的收藏已被删除",
		});
	}

	private async toRecord(row: InternalFavoriteRow): Promise<FavoriteRecord> {
		const [record] = await this.toRecords([row]);
		if (record === undefined) throw new Error("收藏展示解析失败");
		return record;
	}

	private async toRecords(
		rows: readonly InternalFavoriteRow[],
	): Promise<FavoriteRecord[]> {
		const presentations = await this.presentations.resolveAll(rows);
		return rows.map((row, index) =>
			Object.freeze({
				favoriteId: row.favoriteId,
				group: row.group,
				createdAt: row.createdAt,
				presentation: presentations[index] ?? {
					presentationStatus: "TEMPORARILY_UNAVAILABLE" as const,
					retryable: true as const,
				},
			}),
		);
	}
}
