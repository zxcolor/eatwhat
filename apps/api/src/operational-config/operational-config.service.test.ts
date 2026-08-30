import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import type { DatabasePool } from "../database/database-pool.js";
import { OperationalConfigService } from "./operational-config.service.js";

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
		expect(snapshot.aiAssistanceEnabled).toBe(false);
		expect(snapshot.prompt.enabled).toBe(false);
	});

	it("keeps the last validated snapshot during a later database outage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [] })
			.mockRejectedValueOnce(new Error("offline"));
		const service = new OperationalConfigService(
			loadAppConfig({ NODE_ENV: "test", QWEN_ENABLED: "false" }),
			database({ enabled: true, query }),
		);

		expect((await service.current()).source).toBe("DATABASE");
		vi.setSystemTime(new Date("2026-08-30T04:00:06.000Z"));
		const stale = await service.current();

		expect(stale.source).toBe("STALE_CACHE");
		expect(stale.prompt.enabled).toBe(true);
	});
});
