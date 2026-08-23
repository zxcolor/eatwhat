import type { PlaceSearchRequest } from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { applyAmapWebServiceSignature } from "../../providers/amap-request-signature.js";
import {
	attachAmapFailureDiagnostic,
	classifyAmapResponseStatus,
} from "../../providers/amap-response-status.js";
import {
	haversineDistanceMeters,
	toGcj02,
} from "../../recommendations/domain/geo.js";
import { interpretAmapOpenStatus } from "../../recommendations/providers/amap-place.provider.js";
import {
	type PlaceKeywordSearchCandidate,
	type PlaceKeywordSearchFailureReason,
	type PlaceKeywordSearchProvider,
	PlaceKeywordSearchProviderUnavailableError,
} from "../place-keyword-search.provider.js";

export const AMAP_PLACE_KEYWORD_SEARCH_FETCH = Symbol(
	"AMAP_PLACE_KEYWORD_SEARCH_FETCH",
);
export const AMAP_PLACE_SEARCH_RESPONSE_MAX_BYTES = 512 * 1_024;

interface AmapSearchPoi {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly address?: unknown;
	readonly location?: unknown;
	readonly distance?: unknown;
	readonly type?: unknown;
	readonly adcode?: unknown;
	readonly ad_info?: unknown;
	readonly business?: unknown;
	readonly biz_ext?: unknown;
}

interface AmapSearchResponse {
	readonly status?: unknown;
	readonly infocode?: unknown;
	readonly pois?: unknown;
}

interface AmapBusiness {
	readonly rating?: unknown;
	readonly cost?: unknown;
	readonly tag?: unknown;
	readonly opentime_today?: unknown;
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

function numericValue(value: unknown): number | null {
	if (typeof value === "string" && value.trim() === "") return null;
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function parseLocation(
	value: unknown,
): PlaceKeywordSearchCandidate["location"] | null {
	const text = boundedString(value, 64);
	if (text === null) return null;
	const parts = text.split(",");
	if (parts.length !== 2) return null;
	const longitude = Number(parts[0]);
	const latitude = Number(parts[1]);
	return Number.isFinite(longitude) &&
		Number.isFinite(latitude) &&
		longitude >= -180 &&
		longitude <= 180 &&
		latitude >= -90 &&
		latitude <= 90
		? { latitude, longitude, crs: "GCJ02" }
		: null;
}

function beijingAdcode(poi: AmapSearchPoi): string | null {
	const direct = boundedString(poi.adcode, 16);
	const nested = boundedString(objectValue(poi.ad_info)?.adcode, 16);
	const value = direct ?? nested;
	return value !== null && /^11\d{4}$/u.test(value) ? value : null;
}

function tagsFromPoi(
	poi: AmapSearchPoi,
	business: AmapBusiness,
): readonly string[] {
	return [boundedString(business.tag, 400), boundedString(poi.type, 400)]
		.filter((value): value is string => value !== null)
		.flatMap((value) => value.split(/[;|]/u))
		.map((value) => value.trim().slice(0, 80))
		.filter((value) => value.length > 0)
		.filter((value, index, all) => all.indexOf(value) === index)
		.slice(0, 20);
}

function requestCoordinate(value: number): string {
	return value.toFixed(6);
}

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) {
		throw new PlaceKeywordSearchProviderUnavailableError("TIMEOUT");
	}
	return await new Promise<ReadableStreamReadResult<Uint8Array>>(
		(resolve, reject) => {
			const onAbort = () =>
				reject(new PlaceKeywordSearchProviderUnavailableError("TIMEOUT"));
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
			parsedLength > AMAP_PLACE_SEARCH_RESPONSE_MAX_BYTES
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new PlaceKeywordSearchProviderUnavailableError(
				"RESPONSE_TOO_LARGE",
			);
		}
	}
	if (response.body === null) {
		throw new PlaceKeywordSearchProviderUnavailableError("INVALID_RESPONSE");
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
			if (error instanceof PlaceKeywordSearchProviderUnavailableError)
				throw error;
			if (signal.aborted) {
				throw new PlaceKeywordSearchProviderUnavailableError("TIMEOUT");
			}
			throw new PlaceKeywordSearchProviderUnavailableError("INVALID_RESPONSE");
		}
		if (result.done) break;
		totalBytes += result.value.byteLength;
		if (totalBytes > AMAP_PLACE_SEARCH_RESPONSE_MAX_BYTES) {
			void reader.cancel().catch(() => undefined);
			throw new PlaceKeywordSearchProviderUnavailableError(
				"RESPONSE_TOO_LARGE",
			);
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
		throw new PlaceKeywordSearchProviderUnavailableError("INVALID_RESPONSE");
	}
}

@Injectable()
export class AmapPlaceKeywordSearchProvider
	implements PlaceKeywordSearchProvider
{
	readonly dataSource = "AMAP" as const;
	readonly dataMode = "LIVE" as const;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(AMAP_PLACE_KEYWORD_SEARCH_FETCH)
		private readonly fetchImpl: typeof fetch,
	) {}

	async search(
		request: PlaceSearchRequest,
	): Promise<readonly PlaceKeywordSearchCandidate[]> {
		if (!this.config.amap.enabled || this.config.amap.apiKey === null) {
			throw new PlaceKeywordSearchProviderUnavailableError("DISABLED");
		}

		const amapOrigin = toGcj02(request.location);
		const endpoint = new URL("https://restapi.amap.com/v5/place/around");
		endpoint.searchParams.set("key", this.config.amap.apiKey);
		endpoint.searchParams.set("keywords", request.keyword);
		endpoint.searchParams.set(
			"location",
			`${requestCoordinate(amapOrigin.longitude)},${requestCoordinate(amapOrigin.latitude)}`,
		);
		endpoint.searchParams.set("radius", String(request.radiusMeters));
		endpoint.searchParams.set("types", "050000");
		endpoint.searchParams.set("sortrule", "distance");
		endpoint.searchParams.set("region", "北京市");
		endpoint.searchParams.set("city_limit", "true");
		endpoint.searchParams.set("page_size", "25");
		endpoint.searchParams.set("page_num", "1");
		// Photos are deliberately omitted. Only business fields used by this live
		// response are requested, and nothing from the response is cached.
		endpoint.searchParams.set("show_fields", "business");
		endpoint.searchParams.set("output", "json");
		applyAmapWebServiceSignature(endpoint, this.config.amap.signingPrivateKey);

		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.config.amap.timeoutMs,
		);
		try {
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
				throw new PlaceKeywordSearchProviderUnavailableError("UPSTREAM_HTTP");
			}

			const raw = await readBoundedJson(response, controller.signal);
			const body = objectValue(raw) as AmapSearchResponse | null;
			if (body === null) {
				throw new PlaceKeywordSearchProviderUnavailableError(
					"INVALID_RESPONSE",
				);
			}
			const upstreamStatus = classifyAmapResponseStatus(
				body.status,
				body.infocode,
			);
			if (upstreamStatus.classification !== "SUCCESS") {
				throw attachAmapFailureDiagnostic(
					new PlaceKeywordSearchProviderUnavailableError(
						upstreamStatus.classification === "MALFORMED_RESPONSE"
							? "INVALID_RESPONSE"
							: "UPSTREAM_REJECTED",
					),
					upstreamStatus,
				);
			}
			if (!Array.isArray(body.pois)) {
				throw new PlaceKeywordSearchProviderUnavailableError(
					"INVALID_RESPONSE",
				);
			}

			return body.pois
				.slice(0, 25)
				.map((value, index) => this.toCandidate(value, index, amapOrigin))
				.filter(
					(candidate): candidate is PlaceKeywordSearchCandidate =>
						candidate !== null,
				);
		} catch (error) {
			if (error instanceof PlaceKeywordSearchProviderUnavailableError)
				throw error;
			const reason: PlaceKeywordSearchFailureReason = controller.signal.aborted
				? "TIMEOUT"
				: "NETWORK_ERROR";
			throw new PlaceKeywordSearchProviderUnavailableError(reason);
		} finally {
			clearTimeout(timeout);
		}
	}

	private toCandidate(
		value: unknown,
		index: number,
		amapOrigin: ReturnType<typeof toGcj02>,
	): PlaceKeywordSearchCandidate | null {
		const poi = objectValue(value) as AmapSearchPoi | null;
		if (poi === null || beijingAdcode(poi) === null) return null;
		const providerPlaceId = boundedString(poi.id, 160);
		const name = boundedString(poi.name, 160);
		const location = parseLocation(poi.location);
		if (providerPlaceId === null || name === null || location === null)
			return null;

		const business = objectValue(poi.business) ?? {};
		const legacyBusiness = objectValue(poi.biz_ext) ?? {};
		const suppliedDistance = numericValue(poi.distance);
		const calculatedDistance = haversineDistanceMeters(amapOrigin, location);
		const distanceMeters =
			suppliedDistance !== null && suppliedDistance >= 0
				? Math.max(Math.round(suppliedDistance), calculatedDistance)
				: calculatedDistance;
		const rating =
			numericValue(business.rating) ?? numericValue(legacyBusiness.rating);
		const cost =
			numericValue(business.cost) ?? numericValue(legacyBusiness.cost);

		return {
			provider: "AMAP",
			providerPlaceId,
			providerRank: index + 1,
			name,
			address: boundedString(poi.address, 240),
			location,
			distanceMeters,
			sourceLabel: "高德地图实时餐厅数据",
			sourceRating:
				rating !== null && rating >= 0 && rating <= 5 ? rating : null,
			averageCostYuan:
				cost !== null && cost >= 0 && cost <= 20_000 ? cost : null,
			openStatus: interpretAmapOpenStatus(business.opentime_today),
			tags: tagsFromPoi(poi, business),
			dataMode: "LIVE",
			actions: {
				navigate: false,
				call: false,
				copyAddress: false,
				share: false,
			},
		};
	}
}
