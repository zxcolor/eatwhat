import { isToken } from "./contracts";

const SESSION_STORAGE_KEY = "chi-shen-me.auth.refresh.v1";

export interface StoredRefreshSession {
	readonly refreshToken: string;
	readonly refreshTokenExpiresAt: string;
}

export interface StoragePort {
	getStorageSync(key: string): unknown;
	setStorageSync(key: string, value: unknown): void;
	removeStorageSync(key: string): void;
}

function validExpiry(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
		!Number.isNaN(Date.parse(value))
	);
}

export class RefreshSessionStore {
	constructor(private readonly storage: StoragePort) {}

	load(): StoredRefreshSession | null {
		const raw = this.storage.getStorageSync(SESSION_STORAGE_KEY);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			if (raw !== undefined && raw !== null && raw !== "") this.clear();
			return null;
		}
		const record = raw as Record<string, unknown>;
		if (
			Object.keys(record).sort().join(",") !==
				"refreshToken,refreshTokenExpiresAt,version" ||
			record.version !== 1 ||
			!isToken(record.refreshToken) ||
			!validExpiry(record.refreshTokenExpiresAt)
		) {
			this.clear();
			return null;
		}
		return Object.freeze({
			refreshToken: record.refreshToken,
			refreshTokenExpiresAt: record.refreshTokenExpiresAt,
		});
	}

	save(session: StoredRefreshSession): void {
		if (
			!isToken(session.refreshToken) ||
			!validExpiry(session.refreshTokenExpiresAt)
		) {
			throw new Error("SESSION_STORAGE_INVALID");
		}
		this.storage.setStorageSync(SESSION_STORAGE_KEY, {
			version: 1,
			refreshToken: session.refreshToken,
			refreshTokenExpiresAt: session.refreshTokenExpiresAt,
		});
	}

	clear(): void {
		this.storage.removeStorageSync(SESSION_STORAGE_KEY);
	}
}
