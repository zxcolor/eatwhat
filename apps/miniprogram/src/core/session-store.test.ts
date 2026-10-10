import { describe, expect, it, vi } from "vitest";

import { RefreshSessionStore, type StoragePort } from "./session-store";

const REFRESH_TOKEN = "r".repeat(43);
const EXPIRY = "2099-01-01T00:00:00.000Z";

function storageWith(initial?: unknown): {
	readonly storage: StoragePort;
	readonly state: Map<string, unknown>;
} {
	const state = new Map<string, unknown>();
	if (initial !== undefined) state.set("chi-shen-me.auth.refresh.v1", initial);
	return {
		state,
		storage: {
			getStorageSync: (key) => state.get(key),
			setStorageSync: vi.fn((key, value) => state.set(key, value)),
			removeStorageSync: vi.fn((key) => state.delete(key)),
		},
	};
}

describe("RefreshSessionStore", () => {
	it("persists only the rotating refresh material", () => {
		const { storage, state } = storageWith();
		const store = new RefreshSessionStore(storage);

		store.save({ refreshToken: REFRESH_TOKEN, refreshTokenExpiresAt: EXPIRY });

		expect(state.get("chi-shen-me.auth.refresh.v1")).toEqual({
			version: 1,
			refreshToken: REFRESH_TOKEN,
			refreshTokenExpiresAt: EXPIRY,
		});
		expect(
			JSON.stringify(state.get("chi-shen-me.auth.refresh.v1")),
		).not.toContain("accessToken");
	});

	it("loads an exact valid record", () => {
		const { storage } = storageWith({
			version: 1,
			refreshToken: REFRESH_TOKEN,
			refreshTokenExpiresAt: EXPIRY,
		});

		expect(new RefreshSessionStore(storage).load()).toEqual({
			refreshToken: REFRESH_TOKEN,
			refreshTokenExpiresAt: EXPIRY,
		});
	});

	it("clears malformed or extended records instead of accepting them", () => {
		const { storage, state } = storageWith({
			version: 1,
			refreshToken: REFRESH_TOKEN,
			refreshTokenExpiresAt: EXPIRY,
			accessToken: "must-not-be-persisted",
		});

		expect(new RefreshSessionStore(storage).load()).toBeNull();
		expect(state.size).toBe(0);
	});
});
