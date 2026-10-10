import { describe, expect, it, vi } from "vitest";

import {
	createRandomUuid,
	InstallationStore,
	type SecureRandomPort,
} from "./installation";
import type { StoragePort } from "./session-store";

function deterministicRandom(bytes: readonly number[]): SecureRandomPort {
	return {
		getRandomValues(options) {
			const value = new Uint8Array(bytes);
			options.success({
				randomValues: value.buffer.slice(
					value.byteOffset,
					value.byteOffset + value.byteLength,
				),
			});
		},
	};
}

describe("secure mini-program UUIDs", () => {
	it("creates an RFC 4122 UUIDv4 from wx.getRandomValues", async () => {
		const uuid = await createRandomUuid(
			deterministicRandom([
				0, 1, 2, 3, 4, 5, 0xff, 7, 0xff, 9, 10, 11, 12, 13, 14, 15,
			]),
		);

		expect(uuid).toBe("00010203-0405-4f07-bf09-0a0b0c0d0e0f");
	});

	it("fails closed when secure randomness is unavailable", async () => {
		const runtime: SecureRandomPort = {
			getRandomValues(options) {
				options.fail();
			},
		};

		await expect(createRandomUuid(runtime)).rejects.toThrow(
			"SECURE_RANDOM_UNAVAILABLE",
		);
	});

	it("stores a generated installation id only after secure generation succeeds", async () => {
		const state = new Map<string, unknown>();
		const storage: StoragePort = {
			getStorageSync: (key) => state.get(key),
			setStorageSync: vi.fn((key, value) => state.set(key, value)),
			removeStorageSync: vi.fn((key) => state.delete(key)),
		};
		const store = new InstallationStore(
			storage,
			deterministicRandom([
				0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
			]),
		);

		const first = await store.getOrCreate();
		const second = await store.getOrCreate();

		expect(first).toBe(second);
		expect(storage.setStorageSync).toHaveBeenCalledTimes(1);
	});

	it("does not persist an id after a secure-random failure", async () => {
		const storage: StoragePort = {
			getStorageSync: vi.fn(),
			setStorageSync: vi.fn(),
			removeStorageSync: vi.fn(),
		};
		const store = new InstallationStore(storage, {
			getRandomValues(options) {
				options.fail();
			},
		});

		await expect(store.getOrCreate()).rejects.toThrow(
			"SECURE_RANDOM_UNAVAILABLE",
		);
		expect(storage.setStorageSync).not.toHaveBeenCalled();
	});

	it("does not read storage or generate an id before privacy consent", async () => {
		const storage: StoragePort = {
			getStorageSync: vi.fn(),
			setStorageSync: vi.fn(),
			removeStorageSync: vi.fn(),
		};
		const random: SecureRandomPort = {
			getRandomValues: vi.fn(),
		};
		const store = new InstallationStore(storage, random, () => false);

		await expect(store.getOrCreate()).rejects.toThrow(
			"PRIVACY_CONSENT_REQUIRED",
		);
		expect(storage.getStorageSync).not.toHaveBeenCalled();
		expect(random.getRandomValues).not.toHaveBeenCalled();
	});

	it("removes the pseudonymous installation id on privacy withdrawal", () => {
		const storage: StoragePort = {
			getStorageSync: vi.fn(),
			setStorageSync: vi.fn(),
			removeStorageSync: vi.fn(),
		};
		const store = new InstallationStore(
			storage,
			deterministicRandom(new Array(16).fill(0)),
		);

		store.clear();

		expect(storage.removeStorageSync).toHaveBeenCalledWith(
			"chi-shen-me.installation.v1",
		);
	});

	it("does not persist a late random result after privacy withdrawal", async () => {
		const storage: StoragePort = {
			getStorageSync: vi.fn(),
			setStorageSync: vi.fn(),
			removeStorageSync: vi.fn(),
		};
		let randomSuccess:
			| ((result: { randomValues: ArrayBuffer }) => void)
			| null = null;
		const random: SecureRandomPort = {
			getRandomValues(options) {
				randomSuccess = options.success;
			},
		};
		let allowed = true;
		const store = new InstallationStore(storage, random, () => allowed);
		const pending = store.getOrCreate();
		allowed = false;
		if (randomSuccess === null) throw new Error("RANDOM_NOT_STARTED");
		randomSuccess({ randomValues: new Uint8Array(16).buffer });

		await expect(pending).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
		expect(storage.setStorageSync).not.toHaveBeenCalled();
	});
});
