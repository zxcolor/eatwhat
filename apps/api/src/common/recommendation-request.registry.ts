import { createHmac, randomBytes } from "node:crypto";
import {
	type DataSourceCode,
	type MealPeriod,
	type RecommendationEvent,
	type ResultToken,
	ResultTokenSchema,
} from "@chi-shen-me/contracts";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";

export interface RecommendationResultReference {
	readonly provider: DataSourceCode;
	readonly providerPlaceId: string;
}

interface RequestEntry {
	readonly expiresAt: number;
	readonly source: "RECOMMENDATION" | "SEARCH";
	readonly mealPeriod: MealPeriod;
	readonly resultReferences: Map<ResultToken, RecommendationResultReference>;
	readonly consumedEventTokens: Set<string>;
}

export type PersistenceReferencePurpose = "FAVORITE" | "PRIVATE_FEEDBACK";

export interface PersistenceRecommendationReference
	extends RecommendationResultReference {
	readonly mealPeriod: MealPeriod;
}

export interface RecommendationRegistryDiagnostics {
	readonly activeRequestCount: number;
	readonly allowedPlaceTokenCount: number;
	readonly consumedEventTokenCount: number;
}

const REGISTRY_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 60 * 1_000;
const MAXIMUM_ENTRIES = 20_000;

@Injectable()
export class RecommendationRequestRegistry implements OnModuleDestroy {
	private readonly entries = new Map<string, RequestEntry>();
	private readonly processSecret = randomBytes(32);
	private readonly cleanupTimer: NodeJS.Timeout;

	constructor() {
		this.cleanupTimer = setInterval(
			() => this.cleanupExpired(Date.now()),
			CLEANUP_INTERVAL_MS,
		);
		// Registry maintenance must not keep an otherwise idle API process alive.
		this.cleanupTimer.unref();
	}

	/**
	 * Issues one opaque public token per internal result and stores only the
	 * minimum server-side reference needed to validate later events.
	 */
	issue(
		requestId: string,
		references: readonly RecommendationResultReference[],
		mealPeriod: MealPeriod,
	): readonly ResultToken[] {
		return this.issueForSource(
			requestId,
			references,
			mealPeriod,
			"RECOMMENDATION",
		);
	}

	/**
	 * Search results may later be favorited or receive private feedback, but are
	 * not recommendation impressions and must never enter recommendation-event
	 * analytics or history.
	 */
	issueSearch(
		requestId: string,
		references: readonly RecommendationResultReference[],
		mealPeriod: MealPeriod,
	): readonly ResultToken[] {
		return this.issueForSource(requestId, references, mealPeriod, "SEARCH");
	}

	private issueForSource(
		requestId: string,
		references: readonly RecommendationResultReference[],
		mealPeriod: MealPeriod,
		source: RequestEntry["source"],
	): readonly ResultToken[] {
		const now = Date.now();
		this.cleanupExpired(now);

		const previous = this.entries.get(requestId);
		if (previous !== undefined) this.clearEntry(previous);
		this.entries.delete(requestId);
		if (references.length === 0) return Object.freeze([]);

		const resultReferences = new Map<
			ResultToken,
			RecommendationResultReference
		>();
		const resultTokens = references.map((reference) => {
			const token = this.resultToken(
				requestId,
				source,
				reference.provider,
				reference.providerPlaceId,
			);
			resultReferences.set(
				token,
				Object.freeze({
					provider: reference.provider,
					providerPlaceId: reference.providerPlaceId,
				}),
			);
			return token;
		});

		this.entries.set(requestId, {
			expiresAt: now + REGISTRY_LIFETIME_MS,
			source,
			mealPeriod,
			resultReferences,
			consumedEventTokens: new Set(),
		});
		if (this.entries.size > MAXIMUM_ENTRIES) {
			const oldestRequestId = this.entries.keys().next().value as
				| string
				| undefined;
			if (oldestRequestId !== undefined) this.deleteEntry(oldestRequestId);
		}
		return Object.freeze(resultTokens);
	}

	validateAndConsume(
		event: RecommendationEvent,
	): Readonly<RecommendationResultReference> | null {
		const reference = this.validateEventReference(event);
		if (reference === null) return null;
		const entry = this.entries.get(event.requestId);
		if (entry === undefined) return null;
		const eventToken = `${event.type}:${event.resultToken}`;
		entry.consumedEventTokens.add(eventToken);
		return Object.freeze({ ...reference });
	}

	resolveHistoryEvent(
		event: RecommendationEvent,
	): Readonly<PersistenceRecommendationReference> | null {
		const reference = this.validateEventReference(event);
		const entry = this.entries.get(event.requestId);
		return reference === null || entry === undefined
			? null
			: Object.freeze({ ...reference, mealPeriod: entry.mealPeriod });
	}

	releaseEventConsumption(event: RecommendationEvent): void {
		const entry = this.entries.get(event.requestId);
		entry?.consumedEventTokens.delete(`${event.type}:${event.resultToken}`);
	}

	private validateEventReference(
		event: RecommendationEvent,
	): Readonly<RecommendationResultReference> | null {
		const now = Date.now();
		this.cleanupExpired(now);
		const entry = this.entries.get(event.requestId);
		if (entry === undefined || entry.source !== "RECOMMENDATION") return null;
		const occurredAt = Date.parse(event.occurredAt);
		if (
			!Number.isFinite(occurredAt) ||
			occurredAt < now - REGISTRY_LIFETIME_MS ||
			occurredAt > now + 5 * 60_000
		) {
			return null;
		}

		const reference = entry.resultReferences.get(event.resultToken);
		if (reference === undefined) return null;
		const eventToken = `${event.type}:${event.resultToken}`;
		if (entry.consumedEventTokens.has(eventToken)) return null;
		return Object.freeze({ ...reference });
	}

	/**
	 * Resolves a still-live result for an explicit persistence purpose without
	 * consuming the token. A user may legitimately favorite and then submit
	 * private feedback for the same recommendation; each database mutation has
	 * its own user-scoped idempotency boundary.
	 */
	resolveForPersistence(
		requestId: string,
		resultToken: ResultToken,
		purpose: PersistenceReferencePurpose,
	): Readonly<PersistenceRecommendationReference> | null {
		if (purpose !== "FAVORITE" && purpose !== "PRIVATE_FEEDBACK") return null;
		this.cleanupExpired(Date.now());
		const entry = this.entries.get(requestId);
		const reference = entry?.resultReferences.get(resultToken);
		return entry === undefined || reference === undefined
			? null
			: Object.freeze({ ...reference, mealPeriod: entry.mealPeriod });
	}

	revoke(requestId: string): void {
		this.deleteEntry(requestId);
	}

	/** Aggregate-only operational state; never exposes request IDs, POI IDs or tokens. */
	diagnostics(): RecommendationRegistryDiagnostics {
		this.cleanupExpired(Date.now());
		let allowedPlaceTokenCount = 0;
		let consumedEventTokenCount = 0;
		for (const entry of this.entries.values()) {
			allowedPlaceTokenCount += entry.resultReferences.size;
			consumedEventTokenCount += entry.consumedEventTokens.size;
		}
		return Object.freeze({
			activeRequestCount: this.entries.size,
			allowedPlaceTokenCount,
			consumedEventTokenCount,
		});
	}

	onModuleDestroy(): void {
		clearInterval(this.cleanupTimer);
		for (const entry of this.entries.values()) this.clearEntry(entry);
		this.entries.clear();
		this.processSecret.fill(0);
	}

	private resultToken(
		requestId: string,
		source: RequestEntry["source"],
		provider: string,
		providerPlaceId: string,
	): ResultToken {
		return ResultTokenSchema.parse(
			createHmac("sha256", this.processSecret)
				.update(requestId)
				.update("\0")
				.update(source)
				.update("\0")
				.update(provider)
				.update("\0")
				.update(providerPlaceId)
				.digest("base64url"),
		);
	}

	private cleanupExpired(now: number): void {
		for (const [requestId, entry] of this.entries) {
			if (entry.expiresAt <= now) this.deleteEntry(requestId);
		}
	}

	private deleteEntry(requestId: string): void {
		const entry = this.entries.get(requestId);
		if (entry === undefined) return;
		this.clearEntry(entry);
		this.entries.delete(requestId);
	}

	private clearEntry(entry: RequestEntry): void {
		entry.resultReferences.clear();
		entry.consumedEventTokens.clear();
	}
}
