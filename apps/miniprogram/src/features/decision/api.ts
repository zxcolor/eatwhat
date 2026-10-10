import { normalizeApiBaseUrl } from "../../config/runtime";
import type {
	LocationSearchResponse,
	RecommendationContext,
	RecommendationEvent,
	RecommendationEventType,
	RecommendationResponse,
} from "./types";
import {
	isResultToken,
	parseLocationSearchResponse,
	parseRecommendationResponse,
	validateRecommendationContext,
} from "./validation";

const CONTRACT_VERSION_HEADER = "X-ChiShenMe-Contract-Version";
const CONTRACT_VERSION = "1";

export type DecisionApiErrorKind =
	| "NETWORK"
	| "PRIVACY_REQUIRED"
	| "CONTRACT_INCOMPATIBLE"
	| "INVALID_RESPONSE"
	| "HTTP_ERROR";

export class DecisionApiError extends Error {
	constructor(
		readonly kind: DecisionApiErrorKind,
		readonly status: number | null = null,
		readonly code: string | null = null,
	) {
		super(kind);
		this.name = "DecisionApiError";
	}
}

export interface DecisionRequestTask {
	abort?(): void;
}

export interface DecisionHttpRuntime {
	request(options: {
		readonly url: string;
		readonly method: "POST";
		readonly data: unknown;
		readonly header: Record<string, string>;
		readonly timeout: number;
		readonly success: (result: DecisionHttpResult) => void;
		readonly fail: () => void;
	}): DecisionRequestTask | unknown;
}

export interface DecisionHttpResult {
	readonly statusCode: number;
	readonly data: unknown;
	readonly header?: Record<string, unknown>;
}

export interface DecisionApi {
	searchLocation(query: string): Promise<LocationSearchResponse>;
	recommend(context: RecommendationContext): Promise<RecommendationResponse>;
	recordEvent(event: RecommendationEvent): Promise<void>;
}

export class StrictDecisionApiClient implements DecisionApi {
	private readonly baseUrl: string;
	private readonly pending = new Set<() => void>();

	constructor(
		private readonly runtime: DecisionHttpRuntime,
		baseUrl: string,
		private readonly accessToken: () => string | null = () => null,
		private readonly remoteAccessAllowed: () => boolean = () => true,
	) {
		this.baseUrl = normalizeApiBaseUrl(baseUrl);
	}

	searchLocation(query: string): Promise<LocationSearchResponse> {
		return this.post(
			"/v1/location-search",
			{ query },
			parseLocationSearchResponse,
		);
	}

	recommend(context: RecommendationContext): Promise<RecommendationResponse> {
		validateRecommendationContext(context);
		return this.post("/v1/recommendations", context, (value) =>
			parseRecommendationResponse(value, context),
		);
	}

	async recordEvent(event: RecommendationEvent): Promise<void> {
		validateEvent(event);
		await this.post("/v1/recommendation-events", event, () => undefined);
	}

	abortAll(): void {
		for (const cancel of [...this.pending]) cancel();
	}

	private post<T>(
		path: `/${string}`,
		data: unknown,
		parse: (value: unknown) => T,
	): Promise<T> {
		if (!this.remoteAccessAllowed()) {
			return Promise.reject(new DecisionApiError("PRIVACY_REQUIRED"));
		}
		const header: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
			[CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
		};
		const token = this.accessToken();
		if (token !== null && token.length > 0)
			header.Authorization = `Bearer ${token}`;

		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let task: DecisionRequestTask | null = null;
			const finish = (operation: () => void) => {
				if (settled) return;
				settled = true;
				this.pending.delete(cancel);
				operation();
			};
			const cancel = () => {
				if (settled) return;
				finish(() => reject(new DecisionApiError("PRIVACY_REQUIRED")));
				try {
					task?.abort?.();
				} catch {
					// The local promise is already closed and late callbacks are ignored.
				}
			};
			this.pending.add(cancel);
			try {
				const requestTask = this.runtime.request({
					url: `${this.baseUrl}${path}`,
					method: "POST",
					data,
					header,
					timeout: 10_000,
					success: (response) => {
						if (contractHeader(response.header) !== CONTRACT_VERSION) {
							finish(() =>
								reject(
									new DecisionApiError(
										"CONTRACT_INCOMPATIBLE",
										response.statusCode,
									),
								),
							);
							return;
						}
						if (response.statusCode < 200 || response.statusCode >= 300) {
							finish(() =>
								reject(
									new DecisionApiError(
										"HTTP_ERROR",
										response.statusCode,
										safeProblemCode(response.data),
									),
								),
							);
							return;
						}
						try {
							const parsed = parse(response.data);
							finish(() => resolve(parsed));
						} catch {
							finish(() =>
								reject(
									new DecisionApiError("INVALID_RESPONSE", response.statusCode),
								),
							);
						}
					},
					fail: () => finish(() => reject(new DecisionApiError("NETWORK"))),
				});
				if (
					typeof requestTask === "object" &&
					requestTask !== null &&
					"abort" in requestTask
				) {
					task = requestTask as DecisionRequestTask;
				}
			} catch {
				finish(() => reject(new DecisionApiError("NETWORK")));
			}
		});
	}
}

export function recommendationEvent(
	requestId: string,
	resultToken: string,
	type: RecommendationEventType,
	now: () => Date = () => new Date(),
): RecommendationEvent {
	const event = {
		requestId,
		resultToken,
		type,
		occurredAt: now().toISOString(),
	};
	validateEvent(event);
	return Object.freeze(event);
}

function validateEvent(value: RecommendationEvent): void {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
			value.requestId,
		) ||
		!isResultToken(value.resultToken) ||
		![
			"IMPRESSION",
			"DETAIL",
			"FAVORITE",
			"NAVIGATION",
			"CALL",
			"REROLL",
		].includes(value.type) ||
		Number.isNaN(Date.parse(value.occurredAt))
	) {
		throw new Error("RECOMMENDATION_EVENT_INVALID");
	}
}

function contractHeader(
	headers: Record<string, unknown> | undefined,
): string | null {
	if (headers === undefined) return null;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === CONTRACT_VERSION_HEADER.toLowerCase()) {
			return typeof value === "string" ? value : null;
		}
	}
	return null;
}

function safeProblemCode(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const code = (value as Record<string, unknown>).code;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)
		? code
		: null;
}
