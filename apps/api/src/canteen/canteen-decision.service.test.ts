import {
	CANTEEN_SERVER_CATALOG,
	CanteenDecisionRequestSchema,
	CanteenDecisionResponseSchema,
} from "@chi-shen-me/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanteenDecisionService } from "./canteen-decision.service.js";
import { loadCanteenMimoConfig } from "./canteen-mimo.config.js";

const config = () =>
	loadCanteenMimoConfig({
		MIMO_ENABLED: "true",
		MIMO_API_KEY: "synthetic-mimo-key",
	});
const first = CANTEEN_SERVER_CATALOG.items[0];
if (!first) throw new Error("The public menu fixture must be nonempty");
const firstId = first.id;
const request = () =>
	CanteenDecisionRequestSchema.parse({
		requestId: "synthetic-request-1",
		menuVersion: CANTEEN_SERVER_CATALOG.version,
		preferenceRevision: 1,
		consentVersion: "canteen-mimo-v1",
		preferences: { spicyLevel: 2, flavorIntensity: 50 },
		excludedItemIds: [],
	});
const output = (
	content = JSON.stringify({ selectedItemId: firstId }),
	finish = "stop",
) =>
	new Response(
		JSON.stringify({
			choices: [
				{ finish_reason: finish, message: { role: "assistant", content } },
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
afterEach(() => vi.useRealTimers());

describe("MiMo configuration and contract boundaries", () => {
	it("defaults to disabled and never retains an unused key", () => {
		expect(
			loadCanteenMimoConfig({ MIMO_API_KEY: "synthetic-unused-key" }),
		).toEqual({
			enabled: false,
			apiKey: null,
			model: "mimo-v2.6-flash",
			timeoutMs: 8000,
			maxCallsPerMinute: 30,
			maxConcurrency: 4,
		});
	});
	it("rejects missing keys, other providers and invalid resource limits", () => {
		for (const env of [
			{ MIMO_ENABLED: "true" },
			{ MIMO_ENABLED: "yes" },
			{ MIMO_MODEL: "deepseek" },
			{ MIMO_TIMEOUT_MS: "10001" },
			{ MIMO_TIMEOUT_MS: "0" },
			{ MIMO_MAX_CONCURRENCY: "21" },
			{ MIMO_MAX_CALLS_PER_MINUTE: "601" },
			{ MIMO_MAX_CALLS_PER_MINUTE: "1.5" },
		]) {
			expect(() => loadCanteenMimoConfig(env)).toThrow();
		}
	});
	it("rejects extra personal data, non-consented versions, duplicate IDs and invalid slider values", () => {
		for (const patch of [
			{ location: { latitude: 0 } },
			{ accountId: "synthetic" },
			{ consentVersion: "old" },
			{ excludedItemIds: [firstId, firstId] },
			{ preferenceRevision: 0 },
			{ preferences: { spicyLevel: 7, flavorIntensity: 50 } },
			{ preferences: { spicyLevel: 2, flavorIntensity: 101 } },
			{ preferences: { spicyLevel: "2", flavorIntensity: 50 } },
			{ preferences: { spicyLevel: 2, flavorIntensity: 50, prompt: "ignore" } },
		]) {
			expect(
				CanteenDecisionRequestSchema.safeParse({ ...request(), ...patch })
					.success,
			).toBe(false);
		}
	});
});

describe("bounded canteen decision provider", () => {
	it("calls only the fixed official endpoint and returns validated provenance without model text", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(output());
		const result = await new CanteenDecisionService(config(), fetcher).decide(
			request(),
		);
		expect(CanteenDecisionResponseSchema.parse(result)).toEqual({
			requestId: "synthetic-request-1",
			menuVersion: CANTEEN_SERVER_CATALOG.version,
			preferenceRevision: 1,
			status: "SELECTED",
			selectedItemId: firstId,
			source: "MIMO",
			model: "mimo-v2.6-flash",
			fallbackReason: null,
			notice: "TASTE_ATTRIBUTES_UNVERIFIED",
		});
		const [url, options] = fetcher.mock.calls[0] ?? [];
		expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
		expect(options?.redirect).toBe("error");
		expect(options?.headers).toEqual({
			"Content-Type": "application/json",
			"api-key": "synthetic-mimo-key",
		});
		const body = JSON.parse(String(options?.body));
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.max_completion_tokens).toBe(256);
		const input = JSON.parse(body.messages[1].content);
		expect(input.preferences).toEqual(request().preferences);
		expect(input.candidates).toHaveLength(87);
		expect(
			input.candidates.every(
				(item: { spicyLevel: unknown; flavorIntensity: unknown }) =>
					item.spicyLevel === null && item.flavorIntensity === null,
			),
		).toBe(true);
		expect(JSON.stringify(result)).not.toContain("synthetic-mimo-key");
	});
	it("does not call a model when disabled, exhausted or only one candidate remains", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const disabled = await new CanteenDecisionService(
			{ ...config(), enabled: false },
			fetcher,
		).decide(request());
		expect(disabled.source).toBe("LOCAL");
		expect(disabled.fallbackReason).toBe("DISABLED");
		const service = new CanteenDecisionService(config(), fetcher);
		const all = CANTEEN_SERVER_CATALOG.items.map((item) => item.id);
		const exhausted = await service.decide({
			...request(),
			excludedItemIds: all,
		});
		expect(exhausted.status).toBe("EXHAUSTED");
		expect(exhausted.selectedItemId).toBeNull();
		expect(CanteenDecisionResponseSchema.safeParse(exhausted).success).toBe(
			true,
		);
		const single = await service.decide({
			...request(),
			excludedItemIds: all.filter((id) => id !== firstId),
		});
		expect(single.selectedItemId).toBe(firstId);
		expect(single.fallbackReason).toBe("SINGLE_CANDIDATE");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects stale menu versions and foreign exclusions before using provider capacity", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const service = new CanteenDecisionService(config(), fetcher);
		await expect(
			service.decide({ ...request(), menuVersion: "canteen-menu-v999" }),
		).rejects.toThrow();
		await expect(
			service.decide({ ...request(), excludedItemIds: ["foreign-item"] }),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		"{",
		JSON.stringify({ selectedItemId: "foreign-item" }),
		JSON.stringify({ selectedItemId: firstId, price: 0 }),
		JSON.stringify({ selectedItemId: 1 }),
	])(
		"rejects invalid model selection %s without showing raw output",
		async (content) => {
			const result = await new CanteenDecisionService(
				config(),
				vi.fn<typeof fetch>().mockResolvedValue(output(content)),
			).decide(request());
			expect(result.source).toBe("LOCAL");
			expect(result.fallbackReason).toBe("INVALID_MODEL_RESULT");
			expect(
				CANTEEN_SERVER_CATALOG.items.some(
					(item) => item.id === result.selectedItemId,
				),
			).toBe(true);
		},
	);
	it("excludes shown IDs from both the model prompt and all fallbacks", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(output());
		const result = await new CanteenDecisionService(config(), fetcher).decide({
			...request(),
			excludedItemIds: [firstId],
		});
		expect(result.fallbackReason).toBe("INVALID_MODEL_RESULT");
		expect(result.selectedItemId).not.toBe(firstId);
		const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
		expect(
			JSON.parse(body.messages[1].content).candidates.some(
				(item: { id: string }) => item.id === firstId,
			),
		).toBe(false);
	});
	it("rejects truncated and oversized provider responses", async () => {
		for (const response of [
			output(undefined, "length"),
			new Response("x".repeat(50 * 1024)),
		]) {
			const result = await new CanteenDecisionService(
				config(),
				vi.fn<typeof fetch>().mockResolvedValue(response),
			).decide(request());
			expect(result.source).toBe("LOCAL");
			expect(result.model).toBeNull();
		}
	});
	it("returns local provenance for upstream HTTP and transport failures", async () => {
		for (const fetcher of [
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					new Response("private upstream detail", { status: 401 }),
				),
			vi
				.fn<typeof fetch>()
				.mockRejectedValue(new Error("private transport detail")),
		]) {
			const result = await new CanteenDecisionService(config(), fetcher).decide(
				request(),
			);
			expect(result.source).toBe("LOCAL");
			expect(result.fallbackReason).toBe("UNAVAILABLE");
			expect(JSON.stringify(result)).not.toContain("private");
		}
	});
	it("bounds in-flight calls and releases capacity after completion", async () => {
		let resolveFetch: (value: Response) => void = () => {
			throw new Error("not initialized");
		};
		const fetcher = vi.fn<typeof fetch>().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const service = new CanteenDecisionService(
			{ ...config(), maxConcurrency: 1 },
			fetcher,
		);
		const pending = service.decide(request());
		expect((await service.decide(request())).fallbackReason).toBe("CAPACITY");
		expect(fetcher).toHaveBeenCalledTimes(1);
		resolveFetch(output());
		expect((await pending).source).toBe("MIMO");
		fetcher.mockResolvedValue(output());
		expect((await service.decide(request())).source).toBe("MIMO");
	});
	it("enforces the per-minute budget before making a paid request and resets the next window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => output());
		const service = new CanteenDecisionService(
			{ ...config(), maxCallsPerMinute: 1 },
			fetcher,
		);
		expect((await service.decide(request())).source).toBe("MIMO");
		expect((await service.decide(request())).fallbackReason).toBe("CAPACITY");
		expect(fetcher).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date("2026-10-21T00:01:00Z"));
		expect((await service.decide(request())).source).toBe("MIMO");
	});
	it("aborts a timed-out request and releases its concurrency slot", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn<typeof fetch>().mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("synthetic timeout", "AbortError")),
						{ once: true },
					);
				}),
		);
		const service = new CanteenDecisionService(
			{ ...config(), timeoutMs: 10, maxConcurrency: 1 },
			fetcher,
		);
		const pending = service.decide(request());
		await vi.advanceTimersByTimeAsync(10);
		expect((await pending).fallbackReason).toBe("UNAVAILABLE");
		fetcher.mockResolvedValue(output());
		expect((await service.decide(request())).source).toBe("MIMO");
	});
	it("rejects provenance that claims an exhausted round was selected by a model", async () => {
		const result = await new CanteenDecisionService(
			config(),
			vi.fn<typeof fetch>().mockResolvedValue(output()),
		).decide(request());
		for (const patch of [
			{ status: "EXHAUSTED", selectedItemId: null },
			{ fallbackReason: "NO_CANDIDATES", source: "LOCAL", model: null },
		]) {
			expect(
				CanteenDecisionResponseSchema.safeParse({ ...result, ...patch })
					.success,
			).toBe(false);
		}
	});
});
