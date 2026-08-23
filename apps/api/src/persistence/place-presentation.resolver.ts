import type { PersistedPlacePresentation } from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import {
	DATA_RIGHTS_OPERATIONS,
	DataRightsPolicy,
} from "../config/data-rights-policy.js";
import { applyAmapWebServiceSignature } from "../providers/amap-request-signature.js";
import {
	attachAmapFailureDiagnostic,
	classifyAmapResponseStatus,
} from "../providers/amap-response-status.js";
import { interpretAmapOpenStatus } from "../recommendations/providers/amap-place.provider.js";

export const PERSISTENCE_FETCH = Symbol("PERSISTENCE_FETCH");
const MAX_RESPONSE_BYTES = 512 * 1_024;

export interface PresentationReference {
	readonly provider: string | null;
	readonly providerPlaceId: string | null;
	readonly rightsRevokedAt: string | null;
}

function rightsRevoked(): PersistedPlacePresentation {
	return Object.freeze({
		presentationStatus: "RIGHTS_REVOKED",
		retryable: false,
	});
}

function unavailable(): PersistedPlacePresentation {
	return Object.freeze({
		presentationStatus: "TEMPORARILY_UNAVAILABLE",
		retryable: true,
	});
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function numberValue(value: unknown): number | null {
	let parsed: number;
	if (typeof value === "number") {
		parsed = value;
	} else if (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
	) {
		parsed = Number(value);
	} else {
		return null;
	}
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 20_000
		? parsed
		: null;
}

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) throw new Error("AMap timeout");
	return await new Promise<ReadableStreamReadResult<Uint8Array>>(
		(resolve, reject) => {
			const onAbort = () => reject(new Error("AMap timeout"));
			signal.addEventListener("abort", onAbort, { once: true });
			reader
				.read()
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", onAbort));
		},
	);
}

async function boundedJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	const declared = response.headers.get("content-length");
	if (declared !== null && /^\d+$/u.test(declared)) {
		if (Number(declared) > MAX_RESPONSE_BYTES) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error("response too large");
		}
	}
	if (response.body === null) throw new Error("missing response body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		let chunk: ReadableStreamReadResult<Uint8Array>;
		try {
			chunk = await readWithAbort(reader, signal);
		} catch (error) {
			void reader.cancel().catch(() => undefined);
			throw error;
		}
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new Error("response too large");
		}
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(bytes),
	) as unknown;
}

@Injectable()
export class AmapPlacePresentationAdapter {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(PERSISTENCE_FETCH) private readonly fetchImpl: typeof fetch,
	) {}

	async resolveMany(
		providerPlaceIds: readonly string[],
	): Promise<ReadonlyMap<string, PersistedPlacePresentation>> {
		if (!this.config.amap.enabled || this.config.amap.apiKey === null) {
			throw new Error("AMap disabled");
		}
		const resolved = new Map<string, PersistedPlacePresentation>();
		// One resolver call owns one upstream time budget. A 50-item public page
		// may require five official 10-ID batches, but those batches must not each
		// reset AMAP_TIMEOUT_MS and multiply the caller's worst-case latency.
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.config.amap.timeoutMs,
		);
		try {
			for (let offset = 0; offset < providerPlaceIds.length; offset += 10) {
				if (controller.signal.aborted) throw new Error("AMap timeout");
				const ids = providerPlaceIds.slice(offset, offset + 10);
				const endpoint = new URL("https://restapi.amap.com/v5/place/detail");
				endpoint.searchParams.set("key", this.config.amap.apiKey);
				endpoint.searchParams.set("id", ids.join("|"));
				endpoint.searchParams.set("show_fields", "business");
				endpoint.searchParams.set("output", "json");
				applyAmapWebServiceSignature(
					endpoint,
					this.config.amap.signingPrivateKey,
				);
				const response = await this.fetchImpl(endpoint, {
					method: "GET",
					headers: { Accept: "application/json" },
					signal: controller.signal,
					cache: "no-store",
					redirect: "error",
					referrerPolicy: "no-referrer",
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("AMap unavailable");
				}
				const body = objectValue(
					await boundedJson(response, controller.signal),
				);
				if (body === null) throw new Error("AMap rejected response");
				const upstreamStatus = classifyAmapResponseStatus(
					body.status,
					body.infocode,
				);
				if (upstreamStatus.classification !== "SUCCESS") {
					throw attachAmapFailureDiagnostic(
						new Error("AMap rejected response"),
						upstreamStatus,
					);
				}
				if (!Array.isArray(body.pois)) {
					throw new Error("AMap rejected response");
				}
				for (const rawPoi of body.pois.slice(0, 10)) {
					const poi = objectValue(rawPoi);
					const id = stringValue(poi?.id);
					const name = stringValue(poi?.name);
					if (
						poi === null ||
						id === null ||
						name === null ||
						!ids.includes(id)
					) {
						continue;
					}
					const business = objectValue(poi.business) ?? {};
					const legacyBusiness = objectValue(poi.biz_ext) ?? {};
					const tags = [stringValue(business.tag), stringValue(poi.type)]
						.filter((value): value is string => value !== null)
						.flatMap((value) => value.split(/[;|]/u))
						.map((value) => value.trim())
						.filter(Boolean);
					resolved.set(
						id,
						Object.freeze({
							presentationStatus: "AVAILABLE",
							name: name.slice(0, 160),
							address: stringValue(poi.address)?.slice(0, 240) ?? null,
							sourceLabel: "高德地图实时数据",
							dataMode: "LIVE",
							openStatus: interpretAmapOpenStatus(business.opentime_today),
							averageCostYuan:
								numberValue(business.cost) ?? numberValue(legacyBusiness.cost),
							tags: [...new Set(tags)]
								.slice(0, 8)
								.map((tag) => tag.slice(0, 40)),
							resolvedAt: new Date().toISOString(),
						}),
					);
				}
			}
			if (controller.signal.aborted) throw new Error("AMap timeout");
		} catch (error) {
			if (controller.signal.aborted) throw new Error("AMap timeout");
			throw error;
		} finally {
			clearTimeout(timeout);
		}
		return resolved;
	}
}

@Injectable()
export class PlacePresentationResolver {
	constructor(
		private readonly rights: DataRightsPolicy,
		private readonly amap: AmapPlacePresentationAdapter,
	) {}

	supportsLiveProvider(provider: string): boolean {
		return provider === "AMAP";
	}

	async resolveAll(
		references: readonly PresentationReference[],
	): Promise<readonly PersistedPlacePresentation[]> {
		const output = references.map(() => unavailable());
		const amapIndices: number[] = [];
		const amapIds: string[] = [];
		for (const [index, reference] of references.entries()) {
			if (
				reference.rightsRevokedAt !== null ||
				reference.provider === null ||
				reference.providerPlaceId === null
			) {
				output[index] = rightsRevoked();
				continue;
			}
			if (reference.provider === "AMAP") {
				amapIndices.push(index);
				amapIds.push(reference.providerPlaceId);
			}
		}
		if (amapIds.length === 0) return Object.freeze(output);
		const displayAllowed = await this.rights.allowsOperation(
			"AMAP",
			DATA_RIGHTS_OPERATIONS.DISPLAY_LIVE_RESULT,
		);
		if (!displayAllowed) {
			for (const index of amapIndices) output[index] = rightsRevoked();
			return Object.freeze(output);
		}
		try {
			const resolved = await this.amap.resolveMany(amapIds);
			for (const [position, index] of amapIndices.entries()) {
				const id = amapIds[position];
				if (id !== undefined) output[index] = resolved.get(id) ?? unavailable();
			}
		} catch {
			// List/delete must remain usable during an upstream outage. The public
			// union distinguishes this retryable state without exposing provider data.
		}
		return Object.freeze(output);
	}
}
