import { randomUUID } from "node:crypto";
import {
	type CreatePrivateFeedbackRequest,
	type ListPrivateFeedbackQuery,
	PRIVATE_FEEDBACK_STORAGE_TYPE_BY_PUBLIC_TYPE,
	type PrivateFeedbackPage,
	type PrivateFeedbackRecord,
	type PrivateFeedbackStorageType,
	type PrivateFeedbackType,
} from "@chi-shen-me/contracts";
import { ConflictException, Injectable } from "@nestjs/common";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import type { InternalFeedbackRow } from "../persistence/persistence.repository.js";
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

const PUBLIC_TYPE_BY_STORAGE_TYPE = Object.freeze({
	WANT_TO_EAT: "WANT_TO_EAT",
	ATE: "ATE",
	LIKE: "LIKE",
	DISLIKE: "DISLIKE",
	TOO_FAR: "TOO_FAR",
	TOO_EXPENSIVE: "TOO_EXPENSIVE",
	ATE_RECENTLY: "RECENTLY_ATE",
	EXCLUDE_CUISINE: "AVOID_CUISINE",
} as const satisfies Readonly<
	Record<PrivateFeedbackStorageType, PrivateFeedbackType>
>);

@Injectable()
export class PrivateFeedbackService {
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
		input: CreatePrivateFeedbackRequest,
	): Promise<PrivateFeedbackRecord> {
		const user = await this.users.resolve(authorization);
		const reference = this.registry.resolveForPersistence(
			input.result.requestId,
			input.result.resultToken,
			"PRIVATE_FEEDBACK",
		);
		if (reference === null) throw resultReferenceExpired();
		const grant = await this.capability.requireGrant(
			"PRIVATE_FEEDBACK",
			reference.provider,
		);
		this.requireRepository();
		const storageType =
			PRIVATE_FEEDBACK_STORAGE_TYPE_BY_PUBLIC_TYPE[input.type];
		try {
			const result = await this.repository.createFeedback({
				userId: user.userId,
				claim: {
					operation: "CREATE_PRIVATE_FEEDBACK",
					keyHash: persistenceHash(
						"private-feedback-idempotency",
						user.userId,
						input.idempotencyKey,
					),
					requestHash: persistenceHash(
						"private-feedback-create",
						input.result.requestId,
						input.result.resultToken,
						storageType,
					),
					proposedResourceId: randomUUID(),
				},
				reference: {
					provider: reference.provider,
					providerPlaceId: reference.providerPlaceId,
					authorizationId: grant.authorizationId,
					referenceRetainUntil: grant.retainUntil,
				},
				requestCorrelationHash: persistenceHash(
					"recommendation-request",
					input.result.requestId,
				),
				storageType,
			});
			if (result.outcome === "CONFLICT") throw idempotencyConflict();
			if (result.row === null) {
				throw new ConflictException({
					code: "RESOURCE_STATE_CONFLICT",
					message: "首次幂等请求的私有反馈已被删除",
				});
			}
			return await this.toRecord(result.row);
		} catch (error) {
			if (error instanceof ConflictException) throw error;
			throw persistenceUnavailable();
		}
	}

	async list(
		authorization: unknown,
		query: ListPrivateFeedbackQuery,
	): Promise<PrivateFeedbackPage> {
		const user = await this.users.resolve(authorization);
		this.requireRepository();
		const storageType =
			query.type === undefined
				? null
				: PRIVATE_FEEDBACK_STORAGE_TYPE_BY_PUBLIC_TYPE[query.type];
		const filter = storageType ?? "*";
		const boundary = this.cursors.resolve(
			query.cursor,
			user.userId,
			"PRIVATE_FEEDBACK",
			filter,
		);
		try {
			const rows = await this.repository.listFeedback(
				user.userId,
				boundary,
				query.limit + 1,
				storageType,
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
								"PRIVATE_FEEDBACK",
								filter,
								last.createdAt,
								last.feedbackId,
							)
						: null,
			});
		} catch {
			throw persistenceUnavailable();
		}
	}

	async delete(authorization: unknown, feedbackId: string): Promise<void> {
		const user = await this.users.resolve(authorization);
		this.requireRepository();
		try {
			await this.repository.deleteFeedback(user.userId, feedbackId);
		} catch {
			throw persistenceUnavailable();
		}
	}

	async clear(authorization: unknown): Promise<void> {
		const user = await this.users.resolve(authorization);
		this.requireRepository();
		try {
			await this.repository.clearFeedback(user.userId);
		} catch {
			throw persistenceUnavailable();
		}
	}

	private requireRepository(): void {
		if (!this.repository.isAvailable()) throw persistenceUnavailable();
	}

	private async toRecord(
		row: InternalFeedbackRow,
	): Promise<PrivateFeedbackRecord> {
		const [record] = await this.toRecords([row]);
		if (record === undefined) throw new Error("私有反馈展示解析失败");
		return record;
	}

	private async toRecords(
		rows: readonly InternalFeedbackRow[],
	): Promise<PrivateFeedbackRecord[]> {
		const presentations = await this.presentations.resolveAll(rows);
		return rows.map((row, index) =>
			Object.freeze({
				feedbackId: row.feedbackId,
				type: PUBLIC_TYPE_BY_STORAGE_TYPE[row.storageType],
				visibility: "PRIVATE" as const,
				createdAt: row.createdAt,
				presentation: presentations[index] ?? null,
			}),
		);
	}
}
