import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { AdminCrypto } from "./admin-crypto.js";
import { invalidAdminCursor } from "./admin-errors.js";

interface AdminAuditCursorEntry {
	readonly adminUserId: string;
	readonly beforeCreatedAt: string;
	readonly beforeEventId: string;
	readonly expiresAt: number;
}

const CURSOR_TTL_MS = 15 * 60 * 1_000;
const MAX_CURSOR_COUNT = 5_000;

@Injectable()
export class AdminAuditCursorService implements OnModuleDestroy {
	private readonly entries = new Map<string, AdminAuditCursorEntry>();
	private readonly cleanupTimer: NodeJS.Timeout;

	constructor(private readonly crypto: AdminCrypto) {
		this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
		this.cleanupTimer.unref();
	}

	issue(
		adminUserId: string,
		beforeCreatedAt: string,
		beforeEventId: string,
	): string {
		this.cleanup();
		const cursor = this.crypto.issueOpaqueToken();
		this.entries.set(cursor, {
			adminUserId,
			beforeCreatedAt,
			beforeEventId,
			expiresAt: Date.now() + CURSOR_TTL_MS,
		});
		if (this.entries.size > MAX_CURSOR_COUNT) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		return cursor;
	}

	resolve(
		cursor: string | undefined,
		adminUserId: string,
	): {
		readonly beforeCreatedAt: string;
		readonly beforeEventId: string;
	} | null {
		if (cursor === undefined) return null;
		this.cleanup();
		const entry = this.entries.get(cursor);
		if (entry === undefined || entry.adminUserId !== adminUserId) {
			throw invalidAdminCursor();
		}
		return Object.freeze({
			beforeCreatedAt: entry.beforeCreatedAt,
			beforeEventId: entry.beforeEventId,
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
