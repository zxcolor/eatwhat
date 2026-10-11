import { type RecommendationContext, RecommendationContextSchema } from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { applyAmapWebServiceSignature } from "../../providers/amap-request-signature.js";
import {
	attachAmapFailureDiagnostic,
	classifyAmapResponseStatus,
} from "../../providers/amap-response-status.js";
import {
	estimateTravelMinutes,
	haversineDistanceMetersUnrounded,
	toGcj02,
} from "../domain/geo.js";
import type {
	PlaceCandidate,
	PlaceProvider,
} from "../domain/place-candidate.js";
import type { RecommendationQueryPlan } from "../domain/recommendation-query-plan.js";
import {
	BoundedJsonResponseError,
	readBoundedJson,
} from "./bounded-json-response.js";

export const AMAP_FETCH = Symbol("AMAP_FETCH");
export const AMAP_RESPONSE_MAX_BYTES = 512 * 1_024;

interface AmapPoi {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly address?: unknown;
	readonly location?: unknown;
	readonly distance?: unknown;
	readonly type?: unknown;
	readonly business?: unknown;
	readonly biz_ext?: unknown;
}

interface AmapResponse {
	readonly status?: unknown;
	readonly infocode?: unknown;
	readonly pois?: unknown;
}

interface AmapBusiness {
	readonly rating?: unknown;
	readonly cost?: unknown;
	readonly tel?: unknown;
	readonly tag?: unknown;
	readonly opentime_today?: unknown;
}

export type PlaceProviderFailureReason =
	| "DISABLED"
	| "UNSUPPORTED_QUERY_PLAN"
	| "TIMEOUT"
	| "UPSTREAM_HTTP"
	| "UPSTREAM_REJECTED"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR";

export class PlaceProviderUnavailableError extends Error {
	constructor(readonly reason: PlaceProviderFailureReason = "NETWORK_ERROR") {
		super("餐厅数据服务暂时不可用");
		this.name = "PlaceProviderUnavailableError";
	}
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function numericValue(value: unknown): number | null {
	if (typeof value === "string" && value.trim().length === 0) return null;
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

const SAFE_AMAP_KEYWORDS = new Set([
	"早餐",
	"午餐",
	"晚餐",
	"中式快餐",
	"面食",
	"米饭",
	"盖饭",
	"简餐",
	"快餐",
	"小吃",
	"粉",
	"粥",
	"包子",
	"饺子",
	"火锅",
	"川湘菜",
	"湘菜",
	"家常菜",
	"清真",
	"素食",
	"西餐",
	"正餐",
	"聚餐",
]);

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseLocation(value: unknown): {
	longitude: number;
	latitude: number;
	crs: "GCJ02";
} | null {
	const text = stringValue(value);
	if (text === null) return null;
	const parts = text.split(",");
	if (parts.length !== 2) return null;
	const [longitudeText, latitudeText] = parts;
	const longitude = Number(longitudeText);
	const latitude = Number(latitudeText);
	return Number.isFinite(longitude) &&
		Number.isFinite(latitude) &&
		longitude >= -180 &&
		longitude <= 180 &&
		latitude >= -90 &&
		latitude <= 90
		? { longitude, latitude, crs: "GCJ02" }
		: null;
}

function shanghaiHourAndMinute(requestTime: string | undefined): number | null {
	const date = requestTime === undefined ? new Date() : new Date(requestTime);
	if (!Number.isFinite(date.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Shanghai",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
	const minute = Number(
		parts.find((part) => part.type === "minute")?.value ?? "0",
	);
	return hour * 60 + minute;
}

function parseMinuteOfDay(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (match === null) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour >= 0 &&
		hour <= 24 &&
		minute >= 0 &&
		minute < 60 &&
		(hour < 24 || minute === 0)
		? hour * 60 + minute
		: null;
}

export function interpretAmapOpenStatus(
	schedule: unknown,
	requestTime?: string,
): "OPEN" | "CLOSED" | "UNKNOWN" {
	const text = stringValue(schedule);
	if (text === null) return "UNKNOWN";
	if (/^(全天|24小时|24小时营业)$/.test(text)) return "OPEN";
	if (/^(休息|歇业|关闭)$/.test(text)) return "CLOSED";

	const current = shanghaiHourAndMinute(requestTime);
	if (current === null) return "UNKNOWN";
	const ranges: { start: number; end: number }[] = [];
	// Interpret only a complete list of today's numeric ranges. An unrecognised
	// date, closure or other qualifier may override even a range that looks open.
	for (const range of text.split(/[\s;,，；]+/u).filter(Boolean)) {
		const [startText, endText, ...extra] = range.split("-");
		if (startText === undefined || endText === undefined || extra.length > 0)
			return "UNKNOWN";
		const start = parseMinuteOfDay(startText);
		const end = parseMinuteOfDay(endText);
		// 24:00 is an end-of-day endpoint only. Equal endpoints are ambiguous:
		// they do not establish either a full day or a closed business.
		if (start === null || end === null || start === 1_440 || start === end)
			return "UNKNOWN";
		ranges.push({ start, end });
	}
	if (ranges.length === 0) return "UNKNOWN";
	for (const { start, end } of ranges) {
		if (
			start < end
				? current >= start && current < end
				: current >= start || current < end
		) {
			return "OPEN";
		}
	}
	// The source field does not specify whether its closing minute is inclusive.
	// Another range starting at this minute can establish OPEN above; otherwise
	// avoid asserting either OPEN or CLOSED at the ambiguous endpoint. Normalize
	// 24:00 to the same midnight minute as 00:00 for this endpoint check only.
	return ranges.some(({ end }) => current === end % 1_440)
		? "UNKNOWN"
		: "CLOSED";
}

function tagsFromPoi(poi: AmapPoi, business: AmapBusiness): string[] {
	const values = [stringValue(business.tag), stringValue(poi.type)]
		.filter((value): value is string => value !== null)
		.flatMap((value) => value.split(/[;|]/))
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set(values)].slice(0, 20);
}

function requestCoordinate(value: number): string {
	// The official endpoint accepts at most six fractional digits.
	return value.toFixed(6);
}

function safeMealKeywords(mealTypes: readonly string[]): string | null {
	// AMap Search POI 2.0 around accepts one keyword, not an OR expression.
	// Preserve the upstream intent order and send only the first allowlisted term.
	return (
		mealTypes
			.map((item) => item.trim())
			.find((item) => SAFE_AMAP_KEYWORDS.has(item)) ?? null
	);
}

function estimateMealMinutes(tags: readonly string[]): number {
	const joined = tags.join(";");
	if (/火锅|烧烤|聚餐/.test(joined)) return 75;
	if (/快餐|小吃|粉|面|粥|包子/.test(joined)) return 30;
	return 45;
}

@Injectable()
export class AmapPlaceProvider implements PlaceProvider {
	readonly kind = "AMAP" as const;
	readonly dataMode = "LIVE" as const;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(AMAP_FETCH) private readonly fetchImpl: typeof fetch,
	) {}

	supportsQueryPlan(plan: RecommendationQueryPlan): boolean {
		return (
			!plan.providerCapabilityRequired &&
			!plan.profile.providerCapabilityRequired &&
			plan.profile.target === "MEAL" &&
			(plan.profile.version === "meal-breakfast-v1" ||
				plan.profile.version === "meal-lunch-v1" ||
				plan.profile.version === "meal-dinner-v1") &&
			plan.weatherApplication.kind === "NONE" &&
			plan.weatherApplication.version === "weather-none-v1"
		);
	}

	async search(
		context: RecommendationContext,
		plan: RecommendationQueryPlan,
	): Promise<readonly PlaceCandidate[]> {
		if (!this.supportsQueryPlan(plan)) {
			throw new PlaceProviderUnavailableError("UNSUPPORTED_QUERY_PLAN");
		}
		return (await this.searchPage(context, 1, safeMealKeywords(plan.queryTerms))).candidates;
	}

	/** Type-only pagination for the separately authorized local collection path. */
	async searchNearbyPage(location: RecommendationContext["location"], page: number): Promise<{
		candidates: readonly PlaceCandidate[];
		hasMore: boolean;
	}> {
		return this.searchPage(RecommendationContextSchema.parse({
			location, radiusMeters: 3500, mealPeriod: "LUNCH", decisionMode: "QUICK",
			travelMode: "WALK", explorationMode: "BALANCED", partySize: 1,
			availableMinutes: 60, aiAssistanceEnabled: false,
			excludedCuisines: [], preferredCuisines: [],
		}), page, null);
	}

	private async searchPage(context: RecommendationContext, page: number, keywords: string | null): Promise<{
		candidates: readonly PlaceCandidate[];
		hasMore: boolean;
	}> {
		if (!this.config.amap.enabled || this.config.amap.apiKey === null) {
			throw new PlaceProviderUnavailableError("DISABLED");
		}

		// Android/system coordinates are WGS84. Convert exactly once at the AMap
		// boundary; an explicitly GCJ02 origin remains unchanged.
		const amapOrigin = toGcj02(context.location);

		const endpoint = new URL("https://restapi.amap.com/v5/place/around");
		endpoint.searchParams.set("key", this.config.amap.apiKey);
		// 高德官方 around 接口只接受查询参数；该完整 URL 绝不写入应用日志。
		endpoint.searchParams.set(
			"location",
			`${requestCoordinate(amapOrigin.longitude)},${requestCoordinate(amapOrigin.latitude)}`,
		);
		endpoint.searchParams.set("radius", String(context.radiusMeters));
		endpoint.searchParams.set("types", "050000");
		endpoint.searchParams.set("sortrule", "distance");
		endpoint.searchParams.set("page_size", "25");
		endpoint.searchParams.set("page_num", String(page));
		// The official response contract documents a photo URL but no stable owned
		// hostname allowlist. Do not request or surface photos until that boundary
		// is confirmed in writing.
		endpoint.searchParams.set("show_fields", "business");
		endpoint.searchParams.set("output", "json");
		if (keywords !== null) endpoint.searchParams.set("keywords", keywords);
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
				throw new PlaceProviderUnavailableError("UPSTREAM_HTTP");
			}

			const rawBody = await readBoundedJson(
				response,
				controller.signal,
				AMAP_RESPONSE_MAX_BYTES,
			);
			const body = objectValue(rawBody) as AmapResponse | null;
			if (body === null)
				throw new PlaceProviderUnavailableError("INVALID_RESPONSE");
			const upstreamStatus = classifyAmapResponseStatus(
				body.status,
				body.infocode,
			);
			if (upstreamStatus.classification !== "SUCCESS") {
				throw attachAmapFailureDiagnostic(
					new PlaceProviderUnavailableError(
						upstreamStatus.classification === "MALFORMED_RESPONSE"
							? "INVALID_RESPONSE"
							: "UPSTREAM_REJECTED",
					),
					upstreamStatus,
				);
			}
			if (!Array.isArray(body.pois)) {
				throw new PlaceProviderUnavailableError("INVALID_RESPONSE");
			}
			const candidates = body.pois
				.slice(0, 25)
				.map((poi, index) => {
					const poiObject = objectValue(poi);
					return poiObject === null
						? null
						: this.toCandidate(
								poiObject as AmapPoi,
								index,
								context,
								amapOrigin,
							);
				})
				.filter((candidate): candidate is PlaceCandidate => candidate !== null);
			return { candidates, hasMore: body.pois.length >= 25 };
		} catch (error) {
			if (error instanceof PlaceProviderUnavailableError) throw error;
			if (error instanceof BoundedJsonResponseError)
				throw new PlaceProviderUnavailableError(error.reason);
			if (controller.signal.aborted)
				throw new PlaceProviderUnavailableError("TIMEOUT");
			throw new PlaceProviderUnavailableError("NETWORK_ERROR");
		} finally {
			clearTimeout(timeout);
		}
	}

	private toCandidate(
		poi: AmapPoi,
		index: number,
		context: RecommendationContext,
		amapOrigin: ReturnType<typeof toGcj02>,
	): PlaceCandidate | null {
		const providerPlaceId = stringValue(poi.id);
		const name = stringValue(poi.name);
		const location = parseLocation(poi.location);
		if (providerPlaceId === null || name === null || location === null)
			return null;

		const businessObject = objectValue(poi.business) ?? {};
		const legacyBusinessObject = objectValue(poi.biz_ext) ?? {};
		const business: AmapBusiness = businessObject;
		// Both operands are now explicitly GCJ02; mixed-CRS distances throw.
		const calculatedDistance = haversineDistanceMetersUnrounded(
			amapOrigin,
			location,
		);
		const suppliedDistance = numericValue(poi.distance);
		// Never let a malformed or unexpectedly small provider distance bypass the
		// local hard radius. Route/supplied distance can be longer than straight-line
		// distance, so the conservative maximum is safe for filtering.
		const distanceMeters =
			suppliedDistance !== null && suppliedDistance >= 0
				? Math.max(suppliedDistance, calculatedDistance)
				: calculatedDistance;
		const rating =
			numericValue(business.rating) ??
			numericValue(legacyBusinessObject.rating);
		const cost =
			numericValue(business.cost) ?? numericValue(legacyBusinessObject.cost);
		const tags = tagsFromPoi(poi, business);

		return {
			provider: "AMAP",
			providerPlaceId,
			providerRank: index + 1,
			dataMode: "LIVE",
			// Capabilities are supplied by this adapter's data-rights policy. Keep
			// every external action disabled until the corresponding right is
			// confirmed in writing; the engine must not infer rights from a vendor
			// code or the mere presence of a field.
			actions: {
				navigate: false,
				call: false,
				copyAddress: false,
				share: false,
			},
			name,
			address: stringValue(poi.address) ?? "",
			sourceRating:
				rating !== null && rating >= 0 && rating <= 5 ? rating : null,
			averageCostYuan: cost !== null && cost >= 0 ? cost : null,
			distanceMeters,
			estimatedTravelMinutes: estimateTravelMinutes(
				distanceMeters,
				context.travelMode,
			),
			estimatedMealMinutes: estimateMealMinutes(tags),
			openStatus: interpretAmapOpenStatus(
				business.opentime_today,
				context.requestTime,
			),
			tags,
			imageUrl: null,
			phone: stringValue(business.tel),
			location,
			sourceAttribution: "高德地图实时数据",
			editorialAdjustment: 0,
			blocked: false,
		};
	}
}
