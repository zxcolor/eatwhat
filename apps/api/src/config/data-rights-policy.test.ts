import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/database-pool.js";
import { loadAppConfig } from "./app-config.js";
import {
	type AppClock,
	DATA_RIGHTS_OPERATIONS,
	DataRightsPolicy,
} from "./data-rights-policy.js";

const AUTHORIZATION_ID = "11111111-1111-4111-8111-111111111111";

function licensedConfig() {
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@db.invalid:5432/chishenme",
		DATA_RIGHTS_MODE: "LICENSED_ENRICHMENT",
		DATA_RIGHTS_AUTHORIZATION_ID: AUTHORIZATION_ID,
		DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT: "2099-12-31T15:59:59.000Z",
	});
}

function database(query: DatabasePool["query"], enabled = true): DatabasePool {
	return {
		isEnabled: () => enabled,
		query,
	} as DatabasePool;
}

describe("runtime data-rights policy", () => {
	it("requires the database grant for every enrichment operation", async () => {
		const query = vi.fn(async () => ({
			rows: [{ allowed: true }],
			rowCount: 1,
		}));
		const policy = new DataRightsPolicy(
			licensedConfig(),
			{ now: () => Date.parse("2099-12-31T15:59:58.999Z") },
			database(query),
		);

		await expect(policy.effectiveMode("AMAP")).resolves.toBe(
			"LICENSED_ENRICHMENT",
		);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[1]).toEqual([
			AUTHORIZATION_ID,
			"AMAP",
			[
				DATA_RIGHTS_OPERATIONS.DISPLAY_LIVE_RESULT,
				DATA_RIGHTS_OPERATIONS.RESORT_LIVE_RESULT,
				DATA_RIGHTS_OPERATIONS.DISPLAY_OWN_SUITABILITY,
			],
		]);
	});

	it("downgrades immediately at the local expiration boundary", async () => {
		let now = Date.parse("2099-12-31T15:59:58.999Z");
		const clock: AppClock = { now: () => now };
		const query = vi.fn(async () => ({
			rows: [{ allowed: true }],
			rowCount: 1,
		}));
		const policy = new DataRightsPolicy(
			licensedConfig(),
			clock,
			database(query),
		);
		await expect(policy.effectiveMode("AMAP")).resolves.toBe(
			"LICENSED_ENRICHMENT",
		);

		now = Date.parse("2099-12-31T15:59:59.000Z");
		await expect(policy.effectiveMode("AMAP")).resolves.toBe(
			"LIVE_DISPLAY_ONLY",
		);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it.each([
		["database disabled", database(vi.fn(), false)],
		[
			"database denied",
			database(async () => ({ rows: [{ allowed: false }], rowCount: 1 })),
		],
		[
			"database unavailable",
			database(async () => {
				throw new Error("private database failure");
			}),
		],
	])("fails closed when %s", async (_name, databasePool) => {
		const policy = new DataRightsPolicy(
			licensedConfig(),
			{ now: () => 0 },
			databasePool,
		);
		await expect(policy.effectiveMode("AMAP")).resolves.toBe(
			"LIVE_DISPLAY_ONLY",
		);
	});

	it("checks persistence as an independent provider capability", async () => {
		const query = vi.fn(async () => ({
			rows: [{ allowed: true }],
			rowCount: 1,
		}));
		const policy = new DataRightsPolicy(
			licensedConfig(),
			{ now: () => 0 },
			database(query),
		);
		await expect(policy.canPersistPlaceReference("AMAP")).resolves.toBe(true);
		expect(query.mock.calls[0]?.[1]).toEqual([
			AUTHORIZATION_ID,
			"AMAP",
			[DATA_RIGHTS_OPERATIONS.PERSIST_PLACE_REFERENCE],
		]);
	});

	it("always keeps live-only configuration in live-only mode", async () => {
		const query = vi.fn();
		const policy = new DataRightsPolicy(
			loadAppConfig({ NODE_ENV: "test" }),
			{ now: () => 0 },
			database(query),
		);
		await expect(policy.effectiveMode("AMAP")).resolves.toBe(
			"LIVE_DISPLAY_ONLY",
		);
		expect(query).not.toHaveBeenCalled();
	});
});
