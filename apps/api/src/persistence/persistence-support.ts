import { createHash, randomBytes } from "node:crypto";
import type { DataRightsMode, DataSourceCode } from "@chi-shen-me/contracts";
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	GoneException,
	Inject,
	Injectable,
	type OnModuleDestroy,
	ServiceUnavailableException,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { DataRightsPolicy } from "../config/data-rights-policy.js";
import { PlacePresentationResolver } from "./place-presentation.resolver.js";

export function persistenceHash(...parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(String(Buffer.byteLength(part, "utf8")));
		hash.update(":");
		hash.update(part);
		hash.update(";");
	}
	return hash.digest("hex");
}

export function persistenceUnavailable(): ServiceUnavailableException {
	return new ServiceUnavailableException({
		code: "PERSISTENCE_UNAVAILABLE",
		message: "收藏与历史服务暂时不可用",
	});
}

export function persistenceForbidden(): ForbiddenException {
	return new ForbiddenException({
		code: "PERSISTENCE_CAPABILITY_DISABLED",
		message: "当前数据授权不允许保存餐厅引用",
	});
}

export function resultReferenceExpired(): GoneException {
	return new GoneException({
		code: "RESULT_REFERENCE_EXPIRED",
		message: "推荐结果引用已过期，请重新获取推荐",
	});
}

export function idempotencyConflict(): ConflictException {
	return new ConflictException({
		code: "IDEMPOTENCY_KEY_REUSED",
		message: "同一幂等键不能用于不同请求",
	});
}

export interface PersistenceGrant {
	readonly authorizationId: string;
	readonly retainUntil: string;
}

export type PersistenceCapabilityKind =
	| "FAVORITE"
	| "HISTORY"
	| "PRIVATE_FEEDBACK";

@Injectable()
export class PersistenceCapabilityService {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly rights: DataRightsPolicy,
		private readonly presentations: PlacePresentationResolver,
	) {}

	requireDeploymentCapability(kind: PersistenceCapabilityKind): void {
		if (!this.deploymentCapabilityEnabled(kind)) {
			throw persistenceForbidden();
		}
	}

	async requireGrant(
		kind: PersistenceCapabilityKind,
		provider: string,
	): Promise<PersistenceGrant> {
		this.requireDeploymentCapability(kind);
		const authorization = this.config.dataRightsAuthorization;
		if (
			provider === "DEMO" ||
			!this.presentations.supportsLiveProvider(provider) ||
			this.config.dataRightsMode !== "LICENSED_ENRICHMENT" ||
			authorization === null
		) {
			throw persistenceForbidden();
		}
		let effectiveMode: DataRightsMode = "LIVE_DISPLAY_ONLY";
		let canPersistPlaceReference = false;
		try {
			[effectiveMode, canPersistPlaceReference] = await Promise.all([
				this.rights.effectiveMode(provider as DataSourceCode),
				this.rights.canPersistPlaceReference(provider as DataSourceCode),
			]);
		} catch {
			throw persistenceForbidden();
		}
		// Re-check after the asynchronous authorization lookup. This keeps the
		// boundary correct if deployment configuration becomes remotely backed.
		this.requireDeploymentCapability(kind);
		if (effectiveMode !== "LICENSED_ENRICHMENT" || !canPersistPlaceReference) {
			throw persistenceForbidden();
		}
		return Object.freeze({
			authorizationId: authorization.reference,
			retainUntil: authorization.expiresAt,
		});
	}

	private deploymentCapabilityEnabled(
		kind: PersistenceCapabilityKind,
	): boolean {
		if (!this.config.features.accountsEnabled) return false;
		switch (kind) {
			case "FAVORITE":
				return this.config.features.favoritesEnabled;
			case "HISTORY":
				return this.config.features.historyEnabled;
			case "PRIVATE_FEEDBACK":
				return this.config.features.privateFeedbackEnabled;
		}
	}
}

type CursorKind = "FAVORITES" | "HISTORY" | "PRIVATE_FEEDBACK";

interface CursorEntry {
	readonly userId: string;
	readonly kind: CursorKind;
	readonly filter: string;
	readonly beforeAt: string;
	readonly beforeId: string;
	readonly expiresAt: number;
}

const CURSOR_TTL_MS = 15 * 60 * 1_000;
const MAX_CURSORS = 20_000;

@Injectable()
export class PersistenceCursorService implements OnModuleDestroy {
	private readonly entries = new Map<string, CursorEntry>();
	private readonly cleanupTimer: NodeJS.Timeout;

	constructor() {
		this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
		this.cleanupTimer.unref();
	}

	issue(
		userId: string,
		kind: CursorKind,
		filter: string,
		beforeAt: string,
		beforeId: string,
	): string {
		this.cleanup();
		const cursor = randomBytes(32).toString("base64url");
		this.entries.set(cursor, {
			userId,
			kind,
			filter,
			beforeAt,
			beforeId,
			expiresAt: Date.now() + CURSOR_TTL_MS,
		});
		if (this.entries.size > MAX_CURSORS) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		return cursor;
	}

	resolve(
		cursor: string | undefined,
		userId: string,
		kind: CursorKind,
		filter: string,
	): { readonly beforeAt: string; readonly beforeId: string } | null {
		if (cursor === undefined) return null;
		this.cleanup();
		const entry = this.entries.get(cursor);
		if (
			entry === undefined ||
			entry.userId !== userId ||
			entry.kind !== kind ||
			entry.filter !== filter
		) {
			throw new BadRequestException({
				code: "INVALID_CURSOR",
				message: "分页游标无效或已过期",
			});
		}
		return Object.freeze({
			beforeAt: entry.beforeAt,
			beforeId: entry.beforeId,
		});
	}

	onModuleDestroy(): void {
		clearInterval(this.cleanupTimer);
		this.entries.clear();
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [cursor, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(cursor);
		}
	}
}
