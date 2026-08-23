import type {
	FavoriteGroup,
	PrivateFeedbackStorageType,
	RecommendationHistoryAction,
} from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import {
	DatabasePool,
	type DatabaseTransaction,
} from "../database/database-pool.js";

export interface InternalFavoriteRow {
	readonly favoriteId: string;
	readonly group: FavoriteGroup;
	readonly createdAt: string;
	readonly rightsRevokedAt: string | null;
	readonly provider: string | null;
	readonly providerPlaceId: string | null;
}

export interface InternalHistoryRow {
	readonly historyId: string;
	readonly action: RecommendationHistoryAction;
	readonly mealPeriod: "BREAKFAST" | "LUNCH" | "DINNER";
	readonly occurredAt: string;
	readonly expiresAt: string;
	readonly rightsRevokedAt: string | null;
	readonly provider: string | null;
	readonly providerPlaceId: string | null;
}

export interface InternalFeedbackRow {
	readonly feedbackId: string;
	readonly storageType: PrivateFeedbackStorageType;
	readonly createdAt: string;
	readonly rightsRevokedAt: string | null;
	readonly provider: string | null;
	readonly providerPlaceId: string | null;
}

interface FavoriteSqlRow extends QueryResultRow {
	readonly favorite_id: string;
	readonly favorite_group: FavoriteGroup;
	readonly created_at: Date | string;
	readonly rights_revoked_at: Date | string | null;
	readonly provider_code?: string | null;
	readonly provider_place_id?: string | null;
}

interface HistorySqlRow extends QueryResultRow {
	readonly history_id: string;
	readonly event_type: string;
	readonly meal_period: "BREAKFAST" | "LUNCH" | "DINNER";
	readonly occurred_at: Date | string;
	readonly retain_until: Date | string;
	readonly rights_revoked_at: Date | string | null;
	readonly provider_code: string | null;
	readonly provider_place_id: string | null;
}

interface FeedbackSqlRow extends QueryResultRow {
	readonly feedback_id: string;
	readonly feedback_type: PrivateFeedbackStorageType;
	readonly created_at: Date | string;
	readonly rights_revoked_at?: Date | string | null;
	readonly provider_code?: string | null;
	readonly provider_place_id?: string | null;
}

interface ClaimSqlRow extends QueryResultRow {
	readonly outcome: "CLAIMED" | "REPLAY" | "CONFLICT";
	readonly claimed_resource_id: string;
}

export interface PageBoundary {
	readonly beforeAt: string;
	readonly beforeId: string;
}

export interface LicensedReferenceWrite {
	readonly provider: string;
	readonly providerPlaceId: string;
	readonly authorizationId: string;
	readonly referenceRetainUntil: string;
}

export interface IdempotencyClaim {
	readonly operation:
		| "CREATE_FAVORITE"
		| "UPDATE_FAVORITE_GROUP"
		| "CREATE_PRIVATE_FEEDBACK";
	readonly keyHash: string;
	readonly requestHash: string;
	readonly proposedResourceId: string;
}

const HISTORY_ACTION_BY_EVENT = Object.freeze({
	IMPRESSION: "RECOMMENDATION_SHOWN",
	DETAIL: "DETAIL_VIEWED",
	FAVORITE: "FAVORITE_ADDED",
	NAVIGATION: "NAVIGATION_OPENED",
	CALL: "PHONE_DIALER_OPENED",
	REROLL: "REROLL_REQUESTED",
} as const);

function iso(value: Date | string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.valueOf())) throw new Error("数据库时间字段无效");
	return date.toISOString();
}

function nullableIso(value: Date | string | null | undefined): string | null {
	return value === null || value === undefined ? null : iso(value);
}

function favorite(row: FavoriteSqlRow): InternalFavoriteRow {
	return Object.freeze({
		favoriteId: row.favorite_id,
		group: row.favorite_group,
		createdAt: iso(row.created_at),
		rightsRevokedAt: nullableIso(row.rights_revoked_at),
		provider: row.provider_code ?? null,
		providerPlaceId: row.provider_place_id ?? null,
	});
}

function history(row: HistorySqlRow): InternalHistoryRow {
	const action =
		HISTORY_ACTION_BY_EVENT[
			row.event_type as keyof typeof HISTORY_ACTION_BY_EVENT
		];
	if (action === undefined) throw new Error("数据库历史动作未知");
	return Object.freeze({
		historyId: row.history_id,
		action,
		mealPeriod: row.meal_period,
		occurredAt: iso(row.occurred_at),
		expiresAt: iso(row.retain_until),
		rightsRevokedAt: nullableIso(row.rights_revoked_at),
		provider: row.provider_code,
		providerPlaceId: row.provider_place_id,
	});
}

function feedback(row: FeedbackSqlRow): InternalFeedbackRow {
	return Object.freeze({
		feedbackId: row.feedback_id,
		storageType: row.feedback_type,
		createdAt: iso(row.created_at),
		rightsRevokedAt: nullableIso(row.rights_revoked_at),
		provider: row.provider_code ?? null,
		providerPlaceId: row.provider_place_id ?? null,
	});
}

@Injectable()
export class PersistenceRepository {
	constructor(private readonly database: DatabasePool) {}

	isAvailable(): boolean {
		return this.database.isEnabled();
	}

	async createFavorite(input: {
		readonly userId: string;
		readonly claim: IdempotencyClaim;
		readonly reference: LicensedReferenceWrite;
		readonly group: FavoriteGroup;
	}): Promise<{
		readonly outcome: "CREATED" | "REPLAY" | "CONFLICT";
		readonly row: InternalFavoriteRow | null;
	}> {
		return this.database.withTransaction(async (transaction) => {
			const claimed = await this.claim(transaction, input.userId, input.claim);
			if (claimed.outcome === "CONFLICT")
				return { outcome: "CONFLICT", row: null };
			if (claimed.outcome === "REPLAY") {
				return {
					outcome: "REPLAY",
					row: await this.getFavoriteWith(
						transaction,
						input.userId,
						claimed.resourceId,
					),
				};
			}
			const result = await transaction.query<FavoriteSqlRow>(
				`SELECT * FROM public.persistence_insert_favorite(
					$1::uuid, $2::uuid, $3::varchar, $4::varchar,
					$5::uuid, $6::timestamptz, $7::varchar
				)`,
				[
					input.userId,
					input.claim.proposedResourceId,
					input.reference.provider,
					input.reference.providerPlaceId,
					input.reference.authorizationId,
					input.reference.referenceRetainUntil,
					input.group,
				],
			);
			const row = result.rows[0];
			if (row === undefined) throw new Error("收藏写入未返回结果");
			if (row.favorite_id !== input.claim.proposedResourceId) {
				const completion = await transaction.query<{ completed: boolean }>(
					`SELECT public.complete_persistence_idempotency_resource(
						$1::uuid, $2::varchar, $3::varchar, $4::varchar,
						$5::uuid, $6::uuid
					) AS completed`,
					[
						input.userId,
						input.claim.operation,
						input.claim.keyHash,
						input.claim.requestHash,
						input.claim.proposedResourceId,
						row.favorite_id,
					],
				);
				if (completion.rows[0]?.completed !== true) {
					throw new Error("收藏幂等结果封存失败");
				}
			}
			return {
				outcome: "CREATED",
				row: await this.getFavoriteWith(
					transaction,
					input.userId,
					row.favorite_id,
				),
			};
		});
	}

	async updateFavoriteGroup(input: {
		readonly userId: string;
		readonly favoriteId: string;
		readonly claim: IdempotencyClaim;
		readonly group: FavoriteGroup;
	}): Promise<{
		readonly outcome: "UPDATED" | "REPLAY" | "CONFLICT";
		readonly row: InternalFavoriteRow | null;
	}> {
		return this.database.withTransaction(async (transaction) => {
			const claimed = await this.claim(transaction, input.userId, input.claim);
			if (claimed.outcome === "CONFLICT")
				return { outcome: "CONFLICT", row: null };
			if (claimed.outcome === "REPLAY") {
				return {
					outcome: "REPLAY",
					row: await this.getFavoriteWith(
						transaction,
						input.userId,
						claimed.resourceId,
					),
				};
			}
			const result = await transaction.query<FavoriteSqlRow>(
				`SELECT * FROM public.persistence_update_favorite_group(
					$1::uuid, $2::uuid, $3::varchar
				)`,
				[input.userId, input.favoriteId, input.group],
			);
			return {
				outcome: "UPDATED",
				row:
					result.rows[0] === undefined
						? null
						: await this.getFavoriteWith(
								transaction,
								input.userId,
								input.favoriteId,
							),
			};
		});
	}

	async listFavorites(
		userId: string,
		boundary: PageBoundary | null,
		limit: number,
		group: FavoriteGroup | null,
	): Promise<readonly InternalFavoriteRow[]> {
		const result = await this.database.query<FavoriteSqlRow>(
			`SELECT * FROM public.persistence_list_favorites(
				$1::uuid, $2::timestamptz, $3::uuid, $4::integer, $5::varchar
			)`,
			[
				userId,
				boundary?.beforeAt ?? null,
				boundary?.beforeId ?? null,
				limit,
				group,
			],
		);
		return Object.freeze(result.rows.map(favorite));
	}

	async deleteFavorite(userId: string, favoriteId: string): Promise<void> {
		await this.database.query(
			"SELECT public.persistence_delete_favorite($1::uuid, $2::uuid)",
			[userId, favoriteId],
		);
	}

	async recordHistory(input: {
		readonly userId: string;
		readonly historyId: string;
		readonly reference: LicensedReferenceWrite;
		readonly requestHash: string;
		readonly eventType: string;
		readonly mealPeriod: string;
	}): Promise<void> {
		await this.database.query(
			`SELECT * FROM public.persistence_record_history(
				$1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::uuid,
				$6::timestamptz, $7::varchar, $8::varchar, $9::varchar, $10::varchar
			)`,
			[
				input.userId,
				input.historyId,
				input.reference.provider,
				input.reference.providerPlaceId,
				input.reference.authorizationId,
				input.reference.referenceRetainUntil,
				input.requestHash,
				"SHA256-V1",
				input.eventType,
				input.mealPeriod,
			],
		);
	}

	async listHistory(
		userId: string,
		boundary: PageBoundary | null,
		limit: number,
		eventType: string | null,
	): Promise<readonly InternalHistoryRow[]> {
		const result = await this.database.query<HistorySqlRow>(
			`SELECT * FROM public.persistence_list_history(
				$1::uuid, $2::timestamptz, $3::uuid, $4::integer, $5::varchar
			)`,
			[
				userId,
				boundary?.beforeAt ?? null,
				boundary?.beforeId ?? null,
				limit,
				eventType,
			],
		);
		return Object.freeze(result.rows.map(history));
	}

	async clearHistory(userId: string): Promise<void> {
		await this.database.query(
			"SELECT public.persistence_clear_history($1::uuid)",
			[userId],
		);
	}

	async createFeedback(input: {
		readonly userId: string;
		readonly claim: IdempotencyClaim;
		readonly reference: LicensedReferenceWrite;
		readonly requestCorrelationHash: string;
		readonly storageType: PrivateFeedbackStorageType;
	}): Promise<{
		readonly outcome: "CREATED" | "REPLAY" | "CONFLICT";
		readonly row: InternalFeedbackRow | null;
	}> {
		return this.database.withTransaction(async (transaction) => {
			const claimed = await this.claim(transaction, input.userId, input.claim);
			if (claimed.outcome === "CONFLICT")
				return { outcome: "CONFLICT", row: null };
			if (claimed.outcome === "REPLAY") {
				return {
					outcome: "REPLAY",
					row: await this.getFeedbackWith(
						transaction,
						input.userId,
						claimed.resourceId,
					),
				};
			}
			const result = await transaction.query<FeedbackSqlRow>(
				`SELECT * FROM public.persistence_insert_private_feedback(
					$1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::uuid,
					$6::timestamptz, $7::varchar, $8::varchar, $9::varchar
				)`,
				[
					input.userId,
					input.claim.proposedResourceId,
					input.reference.provider,
					input.reference.providerPlaceId,
					input.reference.authorizationId,
					input.reference.referenceRetainUntil,
					input.requestCorrelationHash,
					"SHA256-V1",
					input.storageType,
				],
			);
			const row = result.rows[0];
			if (row === undefined) throw new Error("私有反馈写入未返回结果");
			return {
				outcome: "CREATED",
				row: await this.getFeedbackWith(
					transaction,
					input.userId,
					row.feedback_id,
				),
			};
		});
	}

	async listFeedback(
		userId: string,
		boundary: PageBoundary | null,
		limit: number,
		storageType: PrivateFeedbackStorageType | null,
	): Promise<readonly InternalFeedbackRow[]> {
		const result = await this.database.query<FeedbackSqlRow>(
			`SELECT * FROM public.persistence_list_private_feedback(
				$1::uuid, $2::timestamptz, $3::uuid, $4::integer, $5::varchar
			)`,
			[
				userId,
				boundary?.beforeAt ?? null,
				boundary?.beforeId ?? null,
				limit,
				storageType,
			],
		);
		return Object.freeze(result.rows.map(feedback));
	}

	async deleteFeedback(userId: string, feedbackId: string): Promise<void> {
		await this.database.query(
			"SELECT public.persistence_delete_private_feedback($1::uuid, $2::uuid)",
			[userId, feedbackId],
		);
	}

	async clearFeedback(userId: string): Promise<void> {
		await this.database.query(
			"SELECT public.persistence_clear_private_feedback($1::uuid)",
			[userId],
		);
	}

	private async claim(
		transaction: DatabaseTransaction,
		userId: string,
		claim: IdempotencyClaim,
	): Promise<{
		readonly outcome: ClaimSqlRow["outcome"];
		readonly resourceId: string;
	}> {
		const result = await transaction.query<ClaimSqlRow>(
			`SELECT * FROM public.claim_persistence_idempotency(
				$1::uuid, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::uuid
			)`,
			[
				userId,
				claim.operation,
				claim.keyHash,
				"SHA256-V1",
				claim.requestHash,
				claim.proposedResourceId,
			],
		);
		const row = result.rows[0];
		if (row === undefined) throw new Error("幂等声明未返回结果");
		return { outcome: row.outcome, resourceId: row.claimed_resource_id };
	}

	private async getFavoriteWith(
		transaction: DatabaseTransaction,
		userId: string,
		favoriteId: string,
	): Promise<InternalFavoriteRow | null> {
		const result = await transaction.query<FavoriteSqlRow>(
			"SELECT * FROM public.persistence_get_favorite($1::uuid, $2::uuid)",
			[userId, favoriteId],
		);
		return result.rows[0] === undefined ? null : favorite(result.rows[0]);
	}

	private async getFeedbackWith(
		transaction: DatabaseTransaction,
		userId: string,
		feedbackId: string,
	): Promise<InternalFeedbackRow | null> {
		const result = await transaction.query<FeedbackSqlRow>(
			"SELECT * FROM public.persistence_get_private_feedback($1::uuid, $2::uuid)",
			[userId, feedbackId],
		);
		return result.rows[0] === undefined ? null : feedback(result.rows[0]);
	}
}
