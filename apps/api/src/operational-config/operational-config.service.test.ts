import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import type { DatabasePool } from "../database/database-pool.js";
import { OperationalConfigService } from "./operational-config.service.js";
import { isOperationalConfigAvailable } from "./operational-config.types.js";

function database(input: {
	readonly enabled: boolean;
	readonly query?: ReturnType<typeof vi.fn>;
}): DatabasePool {
	return {
		isEnabled: () => input.enabled,
		query: input.query ?? vi.fn(),
	} as unknown as DatabasePool;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("OperationalConfigService", () => {
	it("preserves startup behavior when persistence is disabled", async () => {
		const query = vi.fn();
		const service = new OperationalConfigService(
			loadAppConfig({ NODE_ENV: "test", QWEN_ENABLED: "false" }),
			database({ enabled: false, query }),
		);

		const snapshot = await service.current();

		expect(snapshot.source).toBe("STARTUP_DEFAULT");
		expect(snapshot.lastSuccessfulReadAt).toBeNull();
		expect(isOperationalConfigAvailable(snapshot)).toBe(true);
		expect(snapshot.recommendationRules).toMatchObject({
			qualityWeight: 25,
			timeWeight: 25,
			budgetWeight: 20,
			intentWeight: 15,
			diversityWeight: 10,
			operationsAdjustmentMaximum: 5,
		});
		expect(query).not.toHaveBeenCalled();
	});

	it("merges only registered, schema-matched active values", async () => {
		const query = vi.fn().mockResolvedValue({
			rows: [
				{
					config_key: "features.ai-assistance",
					version: 2,
					config_schema: "FEATURE_FLAGS_V1",
					value_json: { enabled: false },
				},
				{
					config_key: "recommendations.prompt",
					version: 4,
					config_schema: "PROMPT_SETTINGS_V1",
					value_json: {
						enabled: true,
						promptVersion: "intent-prompt-v1",
						modelVersion: "qwen3.7-flash-2026-07-15",
						timeoutMs: 1_800,
					},
				},
			],
		});
		const service = new OperationalConfigService(
			loadAppConfig({ NODE_ENV: "test", QWEN_ENABLED: "false" }),
			database({ enabled: true, query }),
		);

		const snapshot = await service.current();

		expect(snapshot.source).toBe("DATABASE");
		expect(snapshot.lastSuccessfulReadAt).toEqual(expect.any(String));
		expect(isOperationalConfigAvailable(snapshot)).toBe(true);
		expect(snapshot.aiAssistanceEnabled).toBe(false);
		expect(snapshot.prompt).toMatchObject({
			promptVersion: "intent-prompt-v1",
			modelVersion: "qwen3.7-flash-2026-07-15",
			timeoutMs: 1_800,
		});
		expect(snapshot.versions["features.ai-assistance"]).toBe(2);
		expect(snapshot.versions["recommendations.prompt"]).toBe(4);
	});

	it("fails closed for model transfer when the first database read fails", async () => {
		const service = new OperationalConfigService(
			loadAppConfig({ NODE_ENV: "test", QWEN_ENABLED: "false" }),
			database({
				enabled: true,
				query: vi.fn().mockRejectedValue(new Error("offline")),
			}),
		);

		const snapshot = await service.current();

		expect(snapshot.source).toBe("SAFE_FALLBACK");
		expect(snapshot.lastSuccessfulReadAt).toBeNull();
		expect(isOperationalConfigAvailable(snapshot)).toBe(false);
		expect(snapshot.aiAssistanceEnabled).toBe(false);
		expect(snapshot.prompt.enabled).toBe(false);
	});

	it("closes previously enabled AI on a later outage, preserves diagnostic evidence, and recovers after a successful read", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
		const rows = [
			{ config_key: "features.ai-assistance", version: 3, config_schema: "FEATURE_FLAGS_V1", value_json: { enabled: true } },
			{ config_key: "coverage.default", version: 2, config_schema: "COVERAGE_SETTINGS_V1", value_json: { areaCode: "NATIONWIDE", defaultRadiusMeters: 500, maximumRadiusMeters: 900 } },
		];
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows })
			.mockRejectedValueOnce(new Error("private database failure"))
			.mockRejectedValueOnce(new Error("still offline"))
			.mockResolvedValueOnce({ rows });
		const base = loadAppConfig({ NODE_ENV: "test" });
		const service = new OperationalConfigService(
			{ ...base, qwen: { ...base.qwen, enabled: true } },
			database({ enabled: true, query }),
		);

		const healthy = await service.current();
		expect(healthy.aiAssistanceEnabled).toBe(true);
		expect(healthy.prompt.enabled).toBe(true);
		vi.setSystemTime(new Date("2026-08-30T04:00:05.000Z"));
		const stale = await service.current();

		expect(stale.source).toBe("STALE_CACHE");
		expect(stale.prompt.enabled).toBe(false);
		expect(stale.aiAssistanceEnabled).toBe(false);
		expect(isOperationalConfigAvailable(stale)).toBe(false);
		expect(stale.lastSuccessfulReadAt).toBe("2026-08-30T04:00:00.000Z");
		expect(stale.versions).toEqual(healthy.versions);
		expect(stale.coverage).toEqual(healthy.coverage);
		expect(JSON.stringify(stale)).not.toContain("private database failure");
		vi.setSystemTime(new Date("2026-08-30T04:00:09.999Z"));
		expect(await service.current()).toBe(stale);
		expect(query).toHaveBeenCalledTimes(2);
		vi.setSystemTime(new Date("2026-08-30T04:00:10.000Z"));
		const stillUnavailable = await service.current();
		expect(stillUnavailable.source).toBe("STALE_CACHE");
		expect(stillUnavailable.lastSuccessfulReadAt).toBe(healthy.lastSuccessfulReadAt);
		expect(stillUnavailable.aiAssistanceEnabled).toBe(false);
		vi.setSystemTime(new Date("2026-08-30T04:00:15.000Z"));
		const recovered = await service.current();
		expect(recovered.source).toBe("DATABASE");
		expect(recovered.aiAssistanceEnabled).toBe(true);
		expect(recovered.prompt.enabled).toBe(true);
		expect(recovered.lastSuccessfulReadAt).toBe("2026-08-30T04:00:15.000Z");
		expect(query).toHaveBeenCalledTimes(4);
	});

	it("coalesces concurrent refreshes and starts both timestamp and TTL after the query finishes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
		let finishQuery: ((value: { rows: [] }) => void) | undefined;
		const pending = new Promise<{ rows: [] }>((resolve) => { finishQuery = resolve; });
		const query = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ rows: [] });
		const service = new OperationalConfigService(loadAppConfig({ NODE_ENV: "test" }), database({ enabled: true, query }));
		const first = service.current();
		const second = service.current();
		expect(query).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date("2026-08-30T04:00:02.000Z"));
		finishQuery?.({ rows: [] });
		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(secondSnapshot).toBe(firstSnapshot);
		expect(firstSnapshot.lastSuccessfulReadAt).toBe("2026-08-30T04:00:02.000Z");
		vi.setSystemTime(new Date("2026-08-30T04:00:06.999Z"));
		expect(await service.current()).toBe(firstSnapshot);
		expect(query).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date("2026-08-30T04:00:07.000Z"));
		expect((await service.current()).lastSuccessfulReadAt).toBe("2026-08-30T04:00:07.000Z");
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("caches an initial failure for five seconds without relabeling it as a successful prior read", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
		const query = vi.fn().mockRejectedValue(new Error("offline"));
		const service = new OperationalConfigService(loadAppConfig({ NODE_ENV: "test" }), database({ enabled: true, query }));
		const first = await service.current();
		expect(first.source).toBe("SAFE_FALLBACK");
		vi.setSystemTime(new Date("2026-08-30T04:00:04.999Z"));
		expect(await service.current()).toBe(first);
		expect(query).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date("2026-08-30T04:00:05.000Z"));
		const second = await service.current();
		expect(second.source).toBe("SAFE_FALLBACK");
		expect(second.lastSuccessfulReadAt).toBeNull();
		expect(second.aiAssistanceEnabled).toBe(false);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it.each([
		["1.9.0", "1.10.0", "1.10.0"],
		["2.0.0", "1.10.0", "2.0.0"],
		["1.10.0", "1.10.0", "1.10.0"],
	] as const)("keeps Android minimum %s above deployment floor %s", async (stored, floor, expected) => {
		const base = loadAppConfig({ NODE_ENV: "test" });
		const query = vi.fn().mockResolvedValue({ rows: [
			{ config_key: "clients.minimum-version", version: 2, config_schema: "MINIMUM_APP_VERSION_V1", value_json: { android: stored, ios: "0.2.0" } },
		] });
		const service = new OperationalConfigService(
			{ ...base, features: { ...base.features, minimumSupportedVersion: floor } },
			database({ enabled: true, query }),
		);
		const snapshot = await service.current();
		expect(snapshot.minimumAppVersions).toEqual({ android: expected, ios: "0.2.0" });
		expect(snapshot.versions["clients.minimum-version"]).toBe(2);
	});

	it("treats invalid schema rows as unavailable instead of partially applying an update", async () => {
		const query = vi.fn().mockResolvedValue({ rows: [
			{ config_key: "features.ai-assistance", version: 2, config_schema: "FEATURE_FLAGS_V1", value_json: { enabled: true } },
			{ config_key: "coverage.default", version: 1, config_schema: "COVERAGE_SETTINGS_V1", value_json: { apiSecret: "must-not-be-reflected" } },
		] });
		const service = new OperationalConfigService(loadAppConfig({ NODE_ENV: "test" }), database({ enabled: true, query }));
		const snapshot = await service.current();
		expect(snapshot.source).toBe("SAFE_FALLBACK");
		expect(snapshot.aiAssistanceEnabled).toBe(false);
		expect(snapshot.versions["features.ai-assistance"]).toBeNull();
		expect(JSON.stringify(snapshot)).not.toContain("must-not-be-reflected");
	});
});
