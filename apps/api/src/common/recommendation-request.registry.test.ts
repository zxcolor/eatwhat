import type {
	DataSourceCode,
	RecommendationEvent,
	ResultToken,
} from "@chi-shen-me/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RecommendationRequestRegistry,
	type RecommendationResultReference,
} from "./recommendation-request.registry.js";

interface RegistryEntryProbe {
	readonly resultReferences: Map<ResultToken, RecommendationResultReference>;
	readonly consumedEventTokens: Set<string>;
}

interface RegistryProbe {
	readonly entries: Map<string, RegistryEntryProbe>;
	readonly processSecret: Buffer;
}

const REQUEST_A = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
const REQUEST_B = "3bf305ae-82a1-4f87-86b7-1c97c4a8683f";
const RAW_PLACE_ID = "amap-sensitive-poi-13800138000";
const NOW = new Date("2026-08-20T04:00:00.000Z");
const registries: RecommendationRequestRegistry[] = [];

function createRegistry(): RecommendationRequestRegistry {
	const registry = new RecommendationRequestRegistry();
	registries.push(registry);
	return registry;
}

function probe(registry: RecommendationRequestRegistry): RegistryProbe {
	return registry as unknown as RegistryProbe;
}

function reference(
	providerPlaceId = RAW_PLACE_ID,
	provider: DataSourceCode = "AMAP",
): RecommendationResultReference {
	return { provider, providerPlaceId };
}

function event(
	requestId: string,
	resultToken: ResultToken,
	overrides: Partial<RecommendationEvent> = {},
): RecommendationEvent {
	return {
		requestId,
		resultToken,
		type: "DETAIL",
		occurredAt: NOW.toISOString(),
		...overrides,
	};
}

function issue(
	registry: RecommendationRequestRegistry,
	requestId: string,
	issuedReference: RecommendationResultReference = reference(),
): ResultToken {
	const resultToken = registry.issue(requestId, [issuedReference], "LUNCH")[0];
	if (resultToken === undefined) throw new Error("result token was not issued");
	return resultToken;
}

afterEach(() => {
	for (const registry of registries.splice(0)) registry.onModuleDestroy();
	vi.useRealTimers();
});

describe("RecommendationRequestRegistry opaque result boundary", () => {
	it("issues exact unpadded HMAC tokens and scopes them to one request", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const tokenA = issue(registry, REQUEST_A);
		const tokenB = issue(registry, REQUEST_B);

		expect(tokenA).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(tokenB).not.toBe(tokenA);
		expect(registry.validateAndConsume(event(REQUEST_B, tokenA))).toBeNull();
		expect(registry.validateAndConsume(event(REQUEST_A, tokenA))).toMatchObject(
			{
				provider: "AMAP",
				providerPlaceId: RAW_PLACE_ID,
			},
		);
		expect(registry.validateAndConsume(event(REQUEST_A, tokenA))).toBeNull();
		// Deduplication is per event type, not a blanket one-use token.
		expect(
			registry.validateAndConsume(
				event(REQUEST_A, tokenA, { type: "NAVIGATION" }),
			),
		).toMatchObject({ providerPlaceId: RAW_PLACE_ID });
	});

	it("resolves an immutable server-side provider reference", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const token = issue(
			registry,
			REQUEST_A,
			reference(RAW_PLACE_ID, "AUTHORIZED_VENDOR"),
		);

		const resolved = registry.validateAndConsume(event(REQUEST_A, token));
		expect(resolved).toEqual({
			provider: "AUTHORIZED_VENDOR",
			providerPlaceId: RAW_PLACE_ID,
		});
		expect(Object.isFrozen(resolved)).toBe(true);
	});

	it("resolves the same live token independently for each persistence purpose", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const token = issue(registry, REQUEST_A);

		const favorite = registry.resolveForPersistence(
			REQUEST_A,
			token,
			"FAVORITE",
		);
		const feedback = registry.resolveForPersistence(
			REQUEST_A,
			token,
			"PRIVATE_FEEDBACK",
		);
		expect(favorite).toEqual({
			provider: "AMAP",
			providerPlaceId: RAW_PLACE_ID,
			mealPeriod: "LUNCH",
		});
		expect(feedback).toEqual(favorite);
		expect(Object.isFrozen(favorite)).toBe(true);
		expect(registry.validateAndConsume(event(REQUEST_A, token))).not.toBeNull();
	});

	it("keeps search tokens usable for private persistence but rejects recommendation events", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const token = registry.issueSearch(REQUEST_A, [reference()], "DINNER")[0];
		if (token === undefined) throw new Error("search token was not issued");

		expect(
			registry.resolveForPersistence(REQUEST_A, token, "FAVORITE"),
		).toEqual({
			provider: "AMAP",
			providerPlaceId: RAW_PLACE_ID,
			mealPeriod: "DINNER",
		});
		expect(
			registry.resolveForPersistence(REQUEST_A, token, "PRIVATE_FEEDBACK"),
		).not.toBeNull();
		const runtimeResolver = registry.resolveForPersistence.bind(registry) as (
			requestId: string,
			resultToken: ResultToken,
			purpose: string,
		) => Readonly<unknown> | null;
		expect(runtimeResolver(REQUEST_A, token, "HISTORY")).toBeNull();
		expect(registry.resolveHistoryEvent(event(REQUEST_A, token))).toBeNull();
		expect(registry.validateAndConsume(event(REQUEST_A, token))).toBeNull();
	});

	it("eagerly removes expired mappings even when no new request arrives", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const token = issue(registry, REQUEST_A);
		expect(probe(registry).entries.size).toBe(1);

		vi.advanceTimersByTime(2 * 60 * 60 * 1_000);

		expect(probe(registry).entries.size).toBe(0);
		expect(registry.validateAndConsume(event(REQUEST_A, token))).toBeNull();
	});

	it("rejects unknown, tampered and time-invalid events", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const token = issue(registry, REQUEST_A);
		const replacement = token.endsWith("A") ? "B" : "A";
		const tampered = `${token.slice(0, -1)}${replacement}`;

		expect(registry.validateAndConsume(event(REQUEST_B, token))).toBeNull();
		expect(registry.validateAndConsume(event(REQUEST_A, tampered))).toBeNull();
		expect(
			registry.validateAndConsume(
				event(REQUEST_A, token, {
					occurredAt: new Date(NOW.getTime() + 6 * 60_000).toISOString(),
				}),
			),
		).toBeNull();
	});

	it("clears superseded or explicitly revoked request mappings", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const oldToken = issue(registry, REQUEST_A);
		const oldEntry = probe(registry).entries.get(REQUEST_A);
		const newToken = issue(registry, REQUEST_A, reference("replacement-id"));

		expect(oldEntry?.resultReferences.size).toBe(0);
		expect(registry.validateAndConsume(event(REQUEST_A, oldToken))).toBeNull();
		expect(registry.diagnostics().activeRequestCount).toBe(1);
		registry.revoke(REQUEST_A);
		expect(registry.diagnostics().activeRequestCount).toBe(0);
		expect(registry.validateAndConsume(event(REQUEST_A, newToken))).toBeNull();
	});

	it("keeps diagnostics aggregate-only and clears state and key material on destroy", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registry = createRegistry();
		const token = issue(registry, REQUEST_A);
		const entry = probe(registry).entries.get(REQUEST_A);
		expect(registry.validateAndConsume(event(REQUEST_A, token))).not.toBeNull();

		expect(JSON.stringify(registry.diagnostics())).not.toContain(RAW_PLACE_ID);
		expect(registry.diagnostics()).toEqual({
			activeRequestCount: 1,
			allowedPlaceTokenCount: 1,
			consumedEventTokenCount: 1,
		});

		const secret = probe(registry).processSecret;
		registry.onModuleDestroy();
		expect(entry?.resultReferences.size).toBe(0);
		expect(entry?.consumedEventTokens.size).toBe(0);
		expect(probe(registry).entries.size).toBe(0);
		expect([...secret].every((byte) => byte === 0)).toBe(true);
	});
});
