import { RecommendationContextSchema } from "@chi-shen-me/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../../config/app-config.js";
import { readBoundedJson } from "./bounded-json-response.js";
import { IntentCoordinator } from "./intent-coordinator.js";
import {
	QWEN_RESPONSE_MAX_BYTES,
	QwenIntentProvider,
} from "./qwen-intent.provider.js";
import { buildRuleIntent, RuleIntentProvider } from "./rule-intent.provider.js";

const encoder = new TextEncoder();
const marker = "SYNTHETIC_UPSTREAM_PRIVATE_DETAIL";
const context = RecommendationContextSchema.parse({
	location: { latitude: 0, longitude: 0 },
	mealPeriod: "LUNCH",
	radiusMeters: 1500,
	aiAssistanceEnabled: true,
	preferredCuisines: [],
});
const appConfig = () =>
	loadAppConfig({
		NODE_ENV: "test",
		QWEN_ENABLED: "true",
		QWEN_TIMEOUT_MS: "1000",
		QWEN_BASE_URL:
			"https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		QWEN_API_KEY: "synthetic-test-key",
	});
const profile = {
	cuisineWeights: { 面食: 1 },
	mealTypes: ["面食"],
	speedPreference: "FAST",
	diversityTarget: 0.5,
	explanationSeed: "合成意图",
};
const validBody = encoder.encode(
	JSON.stringify({
		choices: [{ message: { content: JSON.stringify(profile) } }],
	}),
);

function chunkedResponse(
	chunks: readonly Uint8Array[],
	headers?: HeadersInit,
	cancel = vi.fn(),
): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					const chunk = chunks[index++];
					if (chunk === undefined) controller.close();
					else controller.enqueue(chunk);
				},
				cancel,
			},
			{ highWaterMark: 0 },
		),
		{ status: 200, headers },
	);
}

function paddedBody(byteLength: number): Uint8Array {
	const bytes = new Uint8Array(byteLength).fill(32);
	bytes.set(validBody);
	return bytes;
}

afterEach(() => vi.useRealTimers());

describe("bounded Qwen response bytes", () => {
	it.each([undefined, "0", "1", "not-a-length"])(
		"accepts bounded valid JSON regardless of absent or misleading length %s",
		async (length) => {
			const fetchMock = vi.fn(async () =>
				chunkedResponse(
					[validBody.slice(0, 5), validBody.slice(5)],
					length === undefined ? undefined : { "content-length": length },
				),
			);
			const result = await new QwenIntentProvider(
				appConfig(),
				fetchMock as typeof fetch,
			).resolve(context);
			expect(result).toEqual({ ...profile, provider: "QWEN" });
			expect(fetchMock).toHaveBeenCalledOnce();
		},
	);

	it("accepts the byte limit exactly and a UTF-8 character split across chunks", async () => {
		const padded = paddedBody(QWEN_RESPONSE_MAX_BYTES);
		const split = padded.findIndex((byte) => byte >= 0xc0) + 1;
		expect(split).toBeGreaterThan(0);
		const fetchMock = vi.fn(async () =>
			chunkedResponse([padded.slice(0, split), padded.slice(split)]),
		);
		await expect(
			new QwenIntentProvider(appConfig(), fetchMock as typeof fetch).resolve(
				context,
			),
		).resolves.toEqual({ ...profile, provider: "QWEN" });
	});

	it.each([String(QWEN_RESPONSE_MAX_BYTES + 1), "999999999999999999999999"])(
		"cancels an oversized declared response %s without reading the body",
		async (length) => {
			const pull = vi.fn();
			const cancel = vi.fn();
			const fetchMock = vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>(
							{ pull, cancel },
							{ highWaterMark: 0 },
						),
						{ headers: { "content-length": length } },
					),
			);
			await expect(
				new QwenIntentProvider(appConfig(), fetchMock as typeof fetch).resolve(
					context,
				),
			).rejects.toThrow("AI 意图服务暂时不可用");
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(pull).not.toHaveBeenCalled();
			expect(cancel).toHaveBeenCalledTimes(2);
		},
	);

	it.each([undefined, "1", "invalid"])(
		"cancels streamed overflow even if Content-Length is %s",
		async (length) => {
			const cancel = vi.fn();
			const first = paddedBody(QWEN_RESPONSE_MAX_BYTES);
			const fetchMock = vi.fn(async () =>
				chunkedResponse(
					[first, new Uint8Array([32])],
					length === undefined ? undefined : { "content-length": length },
					cancel,
				),
			);
			await expect(
				new QwenIntentProvider(appConfig(), fetchMock as typeof fetch).resolve(
					context,
				),
			).rejects.toThrow("AI 意图服务暂时不可用");
			expect(cancel).toHaveBeenCalledTimes(2);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it("caps bytes rather than JavaScript character count", async () => {
		const body = JSON.stringify({
			choices: [{ message: { content: JSON.stringify(profile) } }],
			metadata: "面".repeat(Math.ceil(QWEN_RESPONSE_MAX_BYTES / 3)),
		});
		expect(body.length).toBeLessThan(QWEN_RESPONSE_MAX_BYTES);
		expect(encoder.encode(body).byteLength).toBeGreaterThan(
			QWEN_RESPONSE_MAX_BYTES,
		);
		const fetchMock = vi.fn(async () => new Response(body));
		await expect(
			new QwenIntentProvider(appConfig(), fetchMock as typeof fetch).resolve(
				context,
			),
		).rejects.toThrow("AI 意图服务暂时不可用");
	});

	it.each([
		{
			label: "invalid UTF-8 inside otherwise valid JSON",
			make: () =>
				chunkedResponse([
					encoder.encode('{"metadata":"'),
					new Uint8Array([0xc3, 0x28]),
					encoder.encode('"}'),
				]),
		},
		{ label: "malformed outer JSON", make: () => new Response(`{${marker}`) },
		{
			label: "malformed inner JSON",
			make: () =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: `{${marker}` } }] }),
				),
		},
		{ label: "empty body", make: () => new Response(null) },
		{
			label: "errored stream",
			make: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.error(new Error(marker));
						},
					}),
				),
		},
	])(
		"normalizes $label without leaking body or original errors",
		async ({ make }) => {
			const fetchMock = vi.fn(async () => make());
			const result = await new QwenIntentProvider(
				appConfig(),
				fetchMock as typeof fetch,
			)
				.resolve(context)
				.catch((error: unknown) => error);
			expect(result).toBeInstanceOf(Error);
			expect(result).toMatchObject({
				name: "QwenIntentUnavailableError",
				message: "AI 意图服务暂时不可用",
			});
			expect(result).not.toHaveProperty("cause");
			expect(String(result)).not.toContain(marker);
			expect(JSON.stringify(result)).not.toContain(marker);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it("cancels an unsuccessful HTTP body without reading upstream details", async () => {
		const pull = vi.fn();
		const cancel = vi.fn();
		const fetchMock = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{ pull, cancel },
						{ highWaterMark: 0 },
					),
					{ status: 502 },
				),
		);
		await expect(
			new QwenIntentProvider(appConfig(), fetchMock as typeof fetch).resolve(
				context,
			),
		).rejects.toThrow("AI 意图服务暂时不可用");
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	it("honors a pre-aborted signal before reading any response bytes", async () => {
		const controller = new AbortController();
		controller.abort();
		const pull = vi.fn();
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
		);
		await expect(
			readBoundedJson(response, controller.signal, QWEN_RESPONSE_MAX_BYTES),
		).rejects.toMatchObject({ reason: "TIMEOUT" });
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("ends hanging body reads within the shared deadline even if stream cancellation never settles", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const signals: AbortSignal[] = [];
		const fetchMock = vi.fn(
			async (_url: URL | RequestInfo, init?: RequestInit) => {
				if (init?.signal) signals.push(init.signal);
				return new Response(
					new ReadableStream<Uint8Array>(
						{ pull() {}, cancel },
						{ highWaterMark: 0 },
					),
				);
			},
		);
		const config = appConfig();
		const resultPromise = new IntentCoordinator(
			config,
			new QwenIntentProvider(config, fetchMock as typeof fetch),
			new RuleIntentProvider(),
		).resolve(context);
		await vi.advanceTimersByTimeAsync(1000);
		const result = await resultPromise;
		expect(result.profile).toEqual(buildRuleIntent(context));
		expect(result.fallbackUsed).toBe(true);
		expect(result.modelVersion).toBe(config.versions.ruleFallbackModel);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(cancel).toHaveBeenCalledTimes(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("falls back deterministically after oversized responses and retains no provider text", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						raw: marker,
						metadata: "x".repeat(QWEN_RESPONSE_MAX_BYTES),
					}),
				),
		);
		const config = appConfig();
		const result = await new IntentCoordinator(
			config,
			new QwenIntentProvider(config, fetchMock as typeof fetch),
			new RuleIntentProvider(),
		).resolve(context);
		expect(result).toEqual({
			profile: buildRuleIntent(context),
			fallbackUsed: true,
			modelVersion: config.versions.ruleFallbackModel,
		});
		expect(JSON.stringify(result)).not.toContain(marker);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
