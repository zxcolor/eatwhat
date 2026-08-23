import { randomUUID } from "node:crypto";
import {
	type ListRecommendationHistoryQuery,
	RECOMMENDATION_HISTORY_STORAGE_EVENT_BY_ACTION,
	type RecommendationEvent,
	type RecommendationHistoryItem,
	type RecommendationHistoryPage,
} from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import type { PersistenceRecommendationReference } from "../common/recommendation-request.registry.js";
import type { InternalHistoryRow } from "../persistence/persistence.repository.js";
import { PersistenceRepository } from "../persistence/persistence.repository.js";
import {
	PersistenceCapabilityService,
	PersistenceCursorService,
	persistenceHash,
	persistenceUnavailable,
} from "../persistence/persistence-support.js";
import { PersistenceUserService } from "../persistence/persistence-user.service.js";
import { PlacePresentationResolver } from "../persistence/place-presentation.resolver.js";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

@Injectable()
export class HistoryPersistenceWriter {
	constructor(
		private readonly capability: PersistenceCapabilityService,
		private readonly repository: PersistenceRepository,
	) {}

	async record(
		userId: string,
		event: RecommendationEvent,
		reference: PersistenceRecommendationReference,
	): Promise<void> {
		const grant = await this.capability.requireGrant(
			"HISTORY",
			reference.provider,
		);
		if (!this.repository.isAvailable()) throw persistenceUnavailable();
		const authorizationExpiry = Date.parse(grant.retainUntil);
		const retainUntil = new Date(
			Math.min(authorizationExpiry, Date.now() + NINETY_DAYS_MS),
		).toISOString();
		try {
			await this.repository.recordHistory({
				userId,
				historyId: randomUUID(),
				reference: {
					provider: reference.provider,
					providerPlaceId: reference.providerPlaceId,
					authorizationId: grant.authorizationId,
					referenceRetainUntil: retainUntil,
				},
				requestHash: persistenceHash("recommendation-request", event.requestId),
				eventType: event.type,
				mealPeriod: reference.mealPeriod,
			});
		} catch {
			throw persistenceUnavailable();
		}
	}
}

@Injectable()
export class HistoryService {
	constructor(
		private readonly users: PersistenceUserService,
		private readonly repository: PersistenceRepository,
		private readonly cursors: PersistenceCursorService,
		private readonly presentations: PlacePresentationResolver,
	) {}

	async list(
		authorization: unknown,
		query: ListRecommendationHistoryQuery,
	): Promise<RecommendationHistoryPage> {
		const user = await this.users.resolve(authorization);
		if (!this.repository.isAvailable()) throw persistenceUnavailable();
		const eventType =
			query.action === undefined
				? null
				: RECOMMENDATION_HISTORY_STORAGE_EVENT_BY_ACTION[query.action];
		const filter = eventType ?? "*";
		const boundary = this.cursors.resolve(
			query.cursor,
			user.userId,
			"HISTORY",
			filter,
		);
		try {
			const rows = await this.repository.listHistory(
				user.userId,
				boundary,
				query.limit + 1,
				eventType,
			);
			const retained = rows.slice(0, query.limit);
			const items = await this.toItems(retained);
			const last = retained.at(-1);
			return Object.freeze({
				items,
				nextCursor:
					rows.length > query.limit && last !== undefined
						? this.cursors.issue(
								user.userId,
								"HISTORY",
								filter,
								last.occurredAt,
								last.historyId,
							)
						: null,
				retentionDays: 90,
			});
		} catch {
			throw persistenceUnavailable();
		}
	}

	async clear(authorization: unknown): Promise<void> {
		const user = await this.users.resolve(authorization);
		if (!this.repository.isAvailable()) throw persistenceUnavailable();
		try {
			await this.repository.clearHistory(user.userId);
		} catch {
			throw persistenceUnavailable();
		}
	}

	private async toItems(
		rows: readonly InternalHistoryRow[],
	): Promise<RecommendationHistoryItem[]> {
		const presentations = await this.presentations.resolveAll(rows);
		return rows.map((row, index) =>
			Object.freeze({
				historyId: row.historyId,
				action: row.action,
				mealPeriod: row.mealPeriod,
				occurredAt: row.occurredAt,
				expiresAt: row.expiresAt,
				presentation: presentations[index] ?? null,
			}),
		);
	}
}
