import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	PlaceSearchRequest,
	RecommendationContext,
} from "@chi-shen-me/contracts";
import { loadAppConfig } from "./config/app-config.js";
import { LocationSearchProviderUnavailableError } from "./location-search/location-search.provider.js";
import { AmapLocationSearchProvider } from "./location-search/providers/amap-location-search.provider.js";
import { PlaceKeywordSearchProviderUnavailableError } from "./place-search/place-keyword-search.provider.js";
import { AmapPlaceKeywordSearchProvider } from "./place-search/providers/amap-place-keyword-search.provider.js";
import { getAmapFailureDiagnostic } from "./providers/amap-response-status.js";
import {
	AmapPlaceProvider,
	PlaceProviderUnavailableError,
} from "./recommendations/providers/amap-place.provider.js";

export type AmapLiveSmokeChain =
	| "GATE"
	| "LOCATION_TEXT"
	| "PLACE_KEYWORD"
	| "RECOMMENDATION_RECALL";

export interface AmapLiveSmokeSuccess {
	readonly ok: true;
	readonly chains: readonly Readonly<{
		chain: Exclude<AmapLiveSmokeChain, "GATE">;
		resultCount: number;
	}>[];
}

export interface AmapLiveSmokeFailureOutput {
	readonly ok: false;
	readonly chain: AmapLiveSmokeChain;
	readonly classification: string;
	readonly safeInfocode: string;
}

interface RunAmapLiveSmokeOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly confirmLiveRequest: boolean;
	readonly fetchImpl: typeof fetch;
}

class AmapLiveSmokeFailure extends Error {
	constructor(
		readonly chain: AmapLiveSmokeChain,
		readonly classification: string,
		readonly safeInfocode = "UNKNOWN",
	) {
		super("AMAP_LIVE_SMOKE_FAILED");
		this.name = "AmapLiveSmokeFailure";
	}
}

const recommendationContext: RecommendationContext = Object.freeze({
	location: Object.freeze({
		latitude: 39.9928,
		longitude: 116.3109,
		crs: "GCJ02" as const,
	}),
	mealPeriod: "LUNCH" as const,
	decisionMode: "QUICK" as const,
	travelMode: "WALK" as const,
	explorationMode: "BALANCED" as const,
	aiAssistanceEnabled: false,
	budgetMaxYuan: null,
	availableMinutes: 60,
	radiusMeters: 1_500,
	partySize: 1,
	excludedCuisines: [],
	preferredCuisines: [],
});

const placeSearchRequest: PlaceSearchRequest = Object.freeze({
	location: Object.freeze({
		latitude: 39.9928,
		longitude: 116.3109,
		crs: "GCJ02" as const,
	}),
	mealPeriod: "LUNCH" as const,
	keyword: "牛肉面",
	radiusMeters: 1_500,
	openNow: false,
	limit: 3,
});

function gateFailure(classification: string): AmapLiveSmokeFailure {
	return new AmapLiveSmokeFailure("GATE", classification);
}

function loadSmokeConfig(env: NodeJS.ProcessEnv, confirmLiveRequest: boolean) {
	if (!confirmLiveRequest) throw gateFailure("CONFIRMATION_REQUIRED");
	if (env.AMAP_LIVE_SMOKE_ENABLED !== "true") {
		throw gateFailure("LIVE_SMOKE_DISABLED");
	}
	if (env.AMAP_ENABLED !== "true") throw gateFailure("AMAP_DISABLED");
	const apiKey = env.AMAP_WEB_SERVICE_KEY?.trim() ?? "";
	if (apiKey.length === 0) throw gateFailure("KEY_MISSING");
	const signingPrivateKey =
		env.AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY?.trim() ?? "";
	if (signingPrivateKey.length === 0) {
		throw gateFailure("SIGNATURE_PRIVATE_KEY_MISSING");
	}
	if (env.AMAP_IP_WHITELIST_CONFIGURED !== "true") {
		throw gateFailure("IP_WHITELIST_NOT_CONFIRMED");
	}

	try {
		// Deliberately pass a minimal environment instead of the process-wide
		// object so this isolated probe never consumes login, database or AI secrets.
		return loadAppConfig({
			NODE_ENV: "test",
			DATA_RIGHTS_MODE: "LIVE_DISPLAY_ONLY",
			ALLOW_DEMO_DATA: "false",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: apiKey,
			AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: signingPrivateKey,
			AMAP_IP_WHITELIST_CONFIGURED: "true",
			AMAP_TIMEOUT_MS: env.AMAP_TIMEOUT_MS,
			QWEN_ENABLED: "false",
			ACCOUNTS_ENABLED: "false",
		});
	} catch {
		throw gateFailure("INVALID_CONFIGURATION");
	}
}

function safeProviderFailure(error: unknown): Readonly<{
	classification: string;
	safeInfocode: string;
}> {
	const amapDiagnostic = getAmapFailureDiagnostic(error);
	if (amapDiagnostic !== null) return amapDiagnostic;

	const reason =
		error instanceof PlaceProviderUnavailableError ||
		error instanceof LocationSearchProviderUnavailableError ||
		error instanceof PlaceKeywordSearchProviderUnavailableError
			? error.reason
			: null;
	switch (reason) {
		case "DISABLED":
			return {
				classification: "CONFIGURATION_OR_PERMISSION",
				safeInfocode: "UNKNOWN",
			};
		case "TIMEOUT":
		case "UPSTREAM_HTTP":
		case "RESPONSE_TOO_LARGE":
		case "NETWORK_ERROR":
			return { classification: reason, safeInfocode: "UNKNOWN" };
		case "INVALID_RESPONSE":
			return { classification: "MALFORMED_RESPONSE", safeInfocode: "UNKNOWN" };
		case "UPSTREAM_REJECTED":
			return { classification: "UNKNOWN_REJECTION", safeInfocode: "UNKNOWN" };
		default:
			return { classification: "INTERNAL_FAILURE", safeInfocode: "UNKNOWN" };
	}
}

function inputUrl(input: URL | RequestInfo): URL | null {
	try {
		if (input instanceof URL) return input;
		if (typeof input === "string") return new URL(input);
		return new URL(input.url);
	} catch {
		return null;
	}
}

async function runChain(
	chain: Exclude<AmapLiveSmokeChain, "GATE">,
	expectedPath: "/v5/place/text" | "/v5/place/around",
	baseFetch: typeof fetch,
	action: (fetchImpl: typeof fetch) => Promise<readonly unknown[]>,
): Promise<
	Readonly<{ chain: Exclude<AmapLiveSmokeChain, "GATE">; resultCount: number }>
> {
	let callCount = 0;
	let endpointMismatch = false;
	const guardedFetch: typeof fetch = async (input, init) => {
		callCount += 1;
		if (callCount !== 1) {
			throw new Error("AMAP_LIVE_SMOKE_CALL_COUNT_MISMATCH");
		}
		const url = inputUrl(input);
		if (
			url === null ||
			url.origin !== "https://restapi.amap.com" ||
			url.pathname !== expectedPath
		) {
			endpointMismatch = true;
			throw new Error("AMAP_LIVE_SMOKE_ENDPOINT_MISMATCH");
		}
		return await baseFetch(input, init);
	};

	try {
		const results = await action(guardedFetch);
		if (callCount !== 1) {
			throw new AmapLiveSmokeFailure(chain, "CALL_COUNT_MISMATCH");
		}
		if (results.length === 0) {
			throw new AmapLiveSmokeFailure(chain, "EMPTY_RESULT");
		}
		return Object.freeze({ chain, resultCount: results.length });
	} catch (error) {
		if (error instanceof AmapLiveSmokeFailure) throw error;
		if (callCount !== 1) {
			throw new AmapLiveSmokeFailure(chain, "CALL_COUNT_MISMATCH");
		}
		if (endpointMismatch) {
			throw new AmapLiveSmokeFailure(chain, "ENDPOINT_MISMATCH");
		}
		const safeFailure = safeProviderFailure(error);
		throw new AmapLiveSmokeFailure(
			chain,
			safeFailure.classification,
			safeFailure.safeInfocode,
		);
	}
}

export async function runAmapLiveSmoke(
	options: RunAmapLiveSmokeOptions,
): Promise<AmapLiveSmokeSuccess> {
	const config = loadSmokeConfig(options.env, options.confirmLiveRequest);
	const chains = [];

	chains.push(
		await runChain(
			"LOCATION_TEXT",
			"/v5/place/text",
			options.fetchImpl,
			async (fetchImpl) =>
				await new AmapLocationSearchProvider(config, fetchImpl).search(
					"北京大学",
				),
		),
	);
	chains.push(
		await runChain(
			"PLACE_KEYWORD",
			"/v5/place/around",
			options.fetchImpl,
			async (fetchImpl) =>
				await new AmapPlaceKeywordSearchProvider(config, fetchImpl).search(
					placeSearchRequest,
				),
		),
	);
	chains.push(
		await runChain(
			"RECOMMENDATION_RECALL",
			"/v5/place/around",
			options.fetchImpl,
			async (fetchImpl) =>
				await new AmapPlaceProvider(config, fetchImpl).search(
					recommendationContext,
					["午餐"],
				),
		),
	);

	return Object.freeze({ ok: true, chains: Object.freeze(chains) });
}

export function safeAmapLiveSmokeFailure(
	error: unknown,
): AmapLiveSmokeFailureOutput {
	if (error instanceof AmapLiveSmokeFailure) {
		return Object.freeze({
			ok: false,
			chain: error.chain,
			classification: error.classification,
			safeInfocode: error.safeInfocode,
		});
	}
	return Object.freeze({
		ok: false,
		chain: "GATE",
		classification: "INTERNAL_FAILURE",
		safeInfocode: "UNKNOWN",
	});
}

async function main(): Promise<void> {
	try {
		const result = await runAmapLiveSmoke({
			env: process.env,
			confirmLiveRequest:
				process.argv.length === 3 &&
				process.argv[2] === "--confirm-live-request",
			fetchImpl: globalThis.fetch,
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(
			`${JSON.stringify(safeAmapLiveSmokeFailure(error))}\n`,
		);
		process.exitCode = 1;
	}
}

const entryPath = process.argv[1];
if (
	entryPath !== undefined &&
	import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
	void main();
}
