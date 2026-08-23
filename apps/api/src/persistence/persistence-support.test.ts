import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PersistenceCursorService,
	persistenceHash,
} from "./persistence-support.js";

const cursors: PersistenceCursorService[] = [];

afterEach(() => {
	for (const cursor of cursors.splice(0)) cursor.onModuleDestroy();
	vi.useRealTimers();
});

describe("persistence privacy helpers", () => {
	it("uses framed deterministic request hashes without retaining input text", () => {
		const token = "sensitive-result-token";
		const first = persistenceHash("favorite", "one", token);
		const second = persistenceHash("favorite", "one", token);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{64}$/u);
		expect(first).not.toContain(token);
		expect(persistenceHash("favorite", "one", "two")).not.toBe(
			persistenceHash("favorite", "one-two"),
		);
	});

	it("binds opaque cursors to user, resource type, filter and expiry", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-21T04:00:00.000Z"));
		const service = new PersistenceCursorService();
		cursors.push(service);
		const cursor = service.issue(
			"user-a",
			"FAVORITES",
			"REGULAR",
			"2026-08-21T03:00:00.000Z",
			"2af305ae-82a1-4f87-86b7-1c97c4a8683f",
		);
		expect(cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(service.resolve(cursor, "user-a", "FAVORITES", "REGULAR")).toEqual({
			beforeAt: "2026-08-21T03:00:00.000Z",
			beforeId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
		});
		expect(() =>
			service.resolve(cursor, "user-b", "FAVORITES", "REGULAR"),
		).toThrow();
		vi.advanceTimersByTime(16 * 60_000);
		expect(() =>
			service.resolve(cursor, "user-a", "FAVORITES", "REGULAR"),
		).toThrow();
	});
});
