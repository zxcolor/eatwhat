import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { applyAmapWebServiceSignature } from "../../providers/amap-request-signature.js";
import {
	attachAmapFailureDiagnostic,
	classifyAmapResponseStatus,
} from "../../providers/amap-response-status.js";
import {
	type LocationSearchCandidate,
	type LocationSearchFailureReason,
	type LocationSearchProvider,
	LocationSearchProviderUnavailableError,
} from "../location-search.provider.js";

export const AMAP_LOCATION_SEARCH_FETCH = Symbol("AMAP_LOCATION_SEARCH_FETCH");
export const AMAP_LOCATION_SEARCH_RESPONSE_MAX_BYTES = 512 * 1_024;

interface AmapTextPoi {
	readonly name?: unknown;
	readonly address?: unknown;
	readonly location?: unknown;
	readonly adcode?: unknown;
	readonly ad_info?: unknown;
}

interface AmapTextResponse {
	readonly status?: unknown;
	readonly infocode?: unknown;
	readonly pois?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundedString(value: unknown, maximum: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed.slice(0, maximum);
}

function parseLocation(
	value: unknown,
): LocationSearchCandidate["location"] | null {
	const text = boundedString(value, 64);
	if (text === null) return null;
	const parts = text.split(",");
	if (parts.length !== 2) return null;
	const longitude = Number(parts[0]);
	const latitude = Number(parts[1]);
	if (
		!Number.isFinite(longitude) ||
		!Number.isFinite(latitude) ||
		longitude < -180 ||
		longitude > 180 ||
		latitude < -90 ||
		latitude > 90
	) {
		return null;
	}
	return { latitude, longitude, crs: "GCJ02" };
}

function beijingAdcode(poi: AmapTextPoi): string | null {
	const direct = boundedString(poi.adcode, 16);
	const adInfo = objectValue(poi.ad_info);
	const nested = boundedString(adInfo?.adcode, 16);
	const value = direct ?? nested;
	return value !== null && /^11\d{4}$/u.test(value) ? value : null;
}

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted)
		throw new LocationSearchProviderUnavailableError("TIMEOUT");
	return await new Promise<ReadableStreamReadResult<Uint8Array>>(
		(resolve, reject) => {
			const onAbort = () =>
				reject(new LocationSearchProviderUnavailableError("TIMEOUT"));
			signal.addEventListener("abort", onAbort, { once: true });
			reader
				.read()
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", onAbort));
		},
	);
}

async function readBoundedJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	const declaredLength = response.headers.get("content-length")?.trim();
	if (declaredLength !== undefined && /^\d+$/u.test(declaredLength)) {
		const parsedLength = Number(declaredLength);
		if (
			!Number.isSafeInteger(parsedLength) ||
			parsedLength > AMAP_LOCATION_SEARCH_RESPONSE_MAX_BYTES
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new LocationSearchProviderUnavailableError("RESPONSE_TOO_LARGE");
		}
	}
	if (response.body === null) {
		throw new LocationSearchProviderUnavailableError("INVALID_RESPONSE");
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		let result: ReadableStreamReadResult<Uint8Array>;
		try {
			result = await readWithAbort(reader, signal);
		} catch (error) {
			void reader.cancel().catch(() => undefined);
			if (error instanceof LocationSearchProviderUnavailableError) throw error;
			if (signal.aborted)
				throw new LocationSearchProviderUnavailableError("TIMEOUT");
			throw new LocationSearchProviderUnavailableError("INVALID_RESPONSE");
		}
		if (result.done) break;
		totalBytes += result.value.byteLength;
		if (totalBytes > AMAP_LOCATION_SEARCH_RESPONSE_MAX_BYTES) {
			void reader.cancel().catch(() => undefined);
			throw new LocationSearchProviderUnavailableError("RESPONSE_TOO_LARGE");
		}
		chunks.push(result.value);
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as unknown;
	} catch {
		throw new LocationSearchProviderUnavailableError("INVALID_RESPONSE");
	}
}

@Injectable()
export class AmapLocationSearchProvider implements LocationSearchProvider {
	readonly dataSource = "AMAP" as const;
	readonly dataMode = "LIVE" as const;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(AMAP_LOCATION_SEARCH_FETCH)
		private readonly fetchImpl: typeof fetch,
	) {}

	async search(query: string): Promise<readonly LocationSearchCandidate[]> {
		if (!this.config.amap.enabled || this.config.amap.apiKey === null) {
			throw new LocationSearchProviderUnavailableError("DISABLED");
		}

		const endpoint = new URL("https://restapi.amap.com/v5/place/text");
		endpoint.searchParams.set("key", this.config.amap.apiKey);
		endpoint.searchParams.set("keywords", query);
		endpoint.searchParams.set("region", "北京市");
		endpoint.searchParams.set("city_limit", "true");
		endpoint.searchParams.set("page_size", "5");
		endpoint.searchParams.set("page_num", "1");
		endpoint.searchParams.set("output", "json");
		applyAmapWebServiceSignature(endpoint, this.config.amap.signingPrivateKey);

		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.config.amap.timeoutMs,
		);
		try {
			// The query and API key exist only in this provider-to-provider URL. The
			// URL is never logged, cached, returned, or used as an application route.
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
				throw new LocationSearchProviderUnavailableError("UPSTREAM_HTTP");
			}

			const raw = await readBoundedJson(response, controller.signal);
			const body = objectValue(raw) as AmapTextResponse | null;
			if (body === null)
				throw new LocationSearchProviderUnavailableError("INVALID_RESPONSE");
			const upstreamStatus = classifyAmapResponseStatus(
				body.status,
				body.infocode,
			);
			if (upstreamStatus.classification !== "SUCCESS") {
				throw attachAmapFailureDiagnostic(
					new LocationSearchProviderUnavailableError(
						upstreamStatus.classification === "MALFORMED_RESPONSE"
							? "INVALID_RESPONSE"
							: "UPSTREAM_REJECTED",
					),
					upstreamStatus,
				);
			}
			if (!Array.isArray(body.pois)) {
				throw new LocationSearchProviderUnavailableError("INVALID_RESPONSE");
			}

			return body.pois
				.slice(0, 5)
				.map((value, index) => this.toCandidate(value, index))
				.filter(
					(candidate): candidate is LocationSearchCandidate =>
						candidate !== null,
				);
		} catch (error) {
			if (error instanceof LocationSearchProviderUnavailableError) throw error;
			const reason: LocationSearchFailureReason = controller.signal.aborted
				? "TIMEOUT"
				: "NETWORK_ERROR";
			throw new LocationSearchProviderUnavailableError(reason);
		} finally {
			clearTimeout(timeout);
		}
	}

	private toCandidate(
		value: unknown,
		index: number,
	): LocationSearchCandidate | null {
		const poi = objectValue(value) as AmapTextPoi | null;
		if (poi === null || beijingAdcode(poi) === null) return null;
		const name = boundedString(poi.name, 120);
		const location = parseLocation(poi.location);
		if (name === null || location === null) return null;
		return {
			name,
			address: boundedString(poi.address, 200),
			location,
			sourceLabel: "高德地图实时地点数据",
			providerRank: index + 1,
		};
	}
}
