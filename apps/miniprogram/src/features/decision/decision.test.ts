import { describe, expect, it, vi } from "vitest";
import {
	type DecisionApi,
	DecisionController,
	type DecisionHttpRuntime,
	DetailActionExecutor,
	evaluateRestaurantActions,
	type LocationChoice,
	type LocationProvider,
	LocationProviderError,
	type LocationSearchResponse,
	parseRecommendationResponse,
	type RecommendationContext,
	type RecommendationEvent,
	type RecommendationResponse,
	ResultSessionStore,
	StrictDecisionApiClient,
	toGcj02,
	validateLocationSearchQuery,
	WechatForegroundLocationProvider,
} from "./index";

describe("decision contract boundary", () => {
	it("rejects private data patterns in ephemeral location lookup", () => {
		expect(validateLocationSearchQuery(" 北京大学 东门 ")).toEqual({
			valid: true,
			query: "北京大学 东门",
		});
		expect(validateLocationSearchQuery("39.9, 116.4").valid).toBe(false);
		expect(validateLocationSearchQuery("13800138000").valid).toBe(false);
		expect(validateLocationSearchQuery("a@example.com").valid).toBe(false);
		expect(validateLocationSearchQuery("北京|海淀").valid).toBe(false);
	});

	it("strictly validates request-scoped recommendation results", () => {
		const context = recommendationContext();
		expect(
			parseRecommendationResponse(recommendationResponse(), context).results,
		).toHaveLength(1);
		expect(() =>
			parseRecommendationResponse(
				{ ...recommendationResponse(), unexpected: true },
				context,
			),
		).toThrow("CONTRACT_RESPONSE_INVALID");
		expect(() =>
			parseRecommendationResponse(
				responseWithResult({ openStatus: "CLOSED" }),
				context,
			),
		).toThrow("CONTRACT_RESPONSE_INVALID");
		expect(() =>
			parseRecommendationResponse(
				responseWithResult({ distanceMeters: 1_501 }),
				context,
			),
		).toThrow("CONTRACT_RESPONSE_INVALID");
		expect(() =>
			parseRecommendationResponse(
				responseWithResult({ fitScore: 88 }),
				context,
			),
		).toThrow("CONTRACT_RESPONSE_INVALID");
	});

	it("aligns WGS84 to the GCJ02 coordinate required by the Mini Program map", () => {
		const converted = toGcj02({
			latitude: 39.908823,
			longitude: 116.39747,
			crs: "WGS84",
		});
		expect(converted?.latitude).toBeCloseTo(39.9102265, 6);
		expect(converted?.longitude).toBeCloseTo(116.4037136, 6);
	});

	it("does not invoke wx.getLocation before privacy consent", async () => {
		const getLocation = vi.fn();
		const provider = new WechatForegroundLocationProvider(
			{ getLocation },
			() => false,
		);

		await expect(provider.currentLocation()).rejects.toMatchObject({
			kind: "PRIVACY_REQUIRED",
		});
		expect(getLocation).not.toHaveBeenCalled();
	});

	it("posts bodies only and enforces the public contract header", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const runtime: DecisionHttpRuntime = {
			request(options) {
				calls.push(options as unknown as Record<string, unknown>);
				options.success({
					statusCode: 200,
					header: { "x-chishenme-contract-version": "1" },
					data: locationSearchResponse(),
				});
				return {};
			},
		};
		const api = new StrictDecisionApiClient(
			runtime,
			"https://api.unfinished-era.com/",
		);
		await expect(api.searchLocation("北京大学东门")).resolves.toMatchObject({
			dataSource: "DEMO",
		});
		expect(calls[0]).toMatchObject({
			url: "https://api.unfinished-era.com/v1/location-search",
			method: "POST",
			data: { query: "北京大学东门" },
		});
		expect(JSON.stringify(calls[0])).not.toContain("latitude");

		const incompatible: DecisionHttpRuntime = {
			request(options) {
				options.success({
					statusCode: 200,
					header: {},
					data: locationSearchResponse(),
				});
				return {};
			},
		};
		await expect(
			new StrictDecisionApiClient(
				incompatible,
				"https://api.unfinished-era.com",
			).searchLocation("清华东门"),
		).rejects.toMatchObject({ kind: "CONTRACT_INCOMPATIBLE" });
	});

	it("checks privacy before reading a token or starting a decision request", async () => {
		const request = vi.fn();
		const accessToken = vi.fn(() => "a".repeat(43));
		const api = new StrictDecisionApiClient(
			{ request },
			"https://api.unfinished-era.com",
			accessToken,
			() => false,
		);

		await expect(api.searchLocation("北京大学东门")).rejects.toMatchObject({
			kind: "PRIVACY_REQUIRED",
		});
		expect(accessToken).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("aborts an in-flight decision request when remote authority closes", async () => {
		const abort = vi.fn();
		const runtime: DecisionHttpRuntime = {
			request() {
				return { abort };
			},
		};
		const api = new StrictDecisionApiClient(
			runtime,
			"https://api.unfinished-era.com",
		);
		const pending = api.searchLocation("北京大学东门");

		api.abortAll();

		await expect(pending).rejects.toMatchObject({ kind: "PRIVACY_REQUIRED" });
		expect(abort).toHaveBeenCalledOnce();
	});
});

describe("DecisionController", () => {
	it("keeps manual location available after location permission refusal", async () => {
		const api = new FakeDecisionApi();
		const controller = new DecisionController(
			api,
			new FailingLocationProvider("PERMISSION_PERMANENTLY_DENIED"),
		);

		await expect(controller.locate()).resolves.toBe(false);
		expect(controller.state.locationState).toMatchObject({
			status: "FAILED",
			kind: "PERMISSION_PERMANENTLY_DENIED",
		});

		controller.setLocation(manualLocation());
		expect(controller.state.form.location?.label).toBe("北京大学东门");
		expect(controller.state.locationState.status).toBe("READY");
	});

	it("clears coordinates, result sessions and pending decision state on withdrawal", async () => {
		const api = new FakeDecisionApi();
		const controller = new DecisionController(
			api,
			new FixedLocationProvider(),
			undefined,
			fixedNow,
		);
		controller.setAccessPolicy(trustedPolicy(1));
		controller.setLocation(manualLocation());
		await expect(controller.recommend()).resolves.toBe(true);

		controller.clearSensitiveState();

		expect(controller.state.form.location).toBeNull();
		expect(controller.state.locationState.status).toBe("IDLE");
		expect(controller.state.locationSearchQuery).toBe("");
		expect(controller.state.recommendation.status).toBe("IDLE");
		expect(controller.sessions.currentResponse()).toBeNull();
		expect(controller.sessions.selected()).toBeNull();
	});

	it("fails closed on unsafe lookup and ignores a response from an old config generation", async () => {
		const deferred = promiseWithResolvers<LocationSearchResponse>();
		const api = new FakeDecisionApi();
		api.searchLocation = vi.fn(() => deferred.promise);
		const controller = new DecisionController(api, new FixedLocationProvider());
		controller.setAccessPolicy(trustedPolicy(1));

		controller.updateLocationSearchQuery("13800138000");
		await expect(controller.searchLocation()).resolves.toBe(false);
		expect(api.searchLocation).not.toHaveBeenCalled();

		controller.updateLocationSearchQuery("北京大学东门");
		const pending = controller.searchLocation();
		expect(controller.state.locationSearchState.status).toBe("LOADING");
		controller.beginConfigurationRefresh(2);
		deferred.resolve(locationSearchResponse());
		await expect(pending).resolves.toBe(false);
		expect(controller.state.locationSearchState.status).toBe("IDLE");
	});

	it("emits only request-scoped events under a trusted current session and rerolls", async () => {
		const api = new FakeDecisionApi();
		const controller = new DecisionController(
			api,
			new FixedLocationProvider(),
			undefined,
			fixedNow,
		);
		controller.setAccessPolicy(trustedPolicy(1));
		controller.setLocation(manualLocation());

		await expect(controller.recommend()).resolves.toBe(true);
		const ready = controller.state.recommendation;
		expect(ready.status).toBe("READY");
		if (ready.status !== "READY") throw new Error("test setup failed");
		const token = ready.response.results[0]?.resultToken;
		if (token === undefined) throw new Error("test setup failed");
		expect(api.events.map((event) => event.type)).toEqual(["IMPRESSION"]);
		expect(controller.selectResultForDetail(token)).toBe(true);
		expect(api.events.map((event) => event.type)).toEqual([
			"IMPRESSION",
			"DETAIL",
		]);

		await expect(controller.reroll()).resolves.toBe(true);
		expect(api.recommendations).toHaveLength(2);
		expect(api.events.map((event) => event.type)).toEqual([
			"IMPRESSION",
			"DETAIL",
			"REROLL",
			"IMPRESSION",
		]);
		for (const event of api.events) {
			expect(Object.keys(event).sort()).toEqual([
				"occurredAt",
				"requestId",
				"resultToken",
				"type",
			]);
		}
	});

	it("fails closed without trusted configuration instead of calling a remote rules-only path", async () => {
		const api = new FakeDecisionApi();
		const controller = new DecisionController(api, new FixedLocationProvider());
		controller.setAccessPolicy({
			generation: 1,
			state: "UNAVAILABLE_RULES_ONLY",
			recommendationsEnabled: false,
			locationSearchEnabled: false,
			aiEnabled: false,
		});
		controller.setLocation(manualLocation());

		await expect(controller.recommend()).resolves.toBe(false);
		expect(controller.state.recommendation).toEqual({ status: "IDLE" });
		expect(api.recommendations).toEqual([]);
		expect(api.events).toEqual([]);
	});
});

describe("detail action gate", () => {
	it("keeps share closed and independently enforces server capabilities", () => {
		const result = recommendationResponse().results[0];
		if (result === undefined) throw new Error("test setup failed");
		const availability = evaluateRestaurantActions(result, "CURRENT");
		expect(availability.navigate.enabled).toBe(true);
		expect(availability.call.enabled).toBe(true);
		expect(availability.copyAddress.enabled).toBe(true);
		expect(availability.share).toEqual({
			enabled: false,
			unavailableReason: "CLIENT_FEATURE_DISABLED",
		});
		expect(
			evaluateRestaurantActions(
				{ ...result, actions: { ...result.actions, call: false } },
				"CURRENT",
			).call,
		).toEqual({ enabled: false, unavailableReason: "SOURCE_NOT_ENABLED" });
	});

	it("rechecks the live session before every platform action", async () => {
		const sessions = new ResultSessionStore(fixedNow);
		sessions.confirmConfiguration(1);
		sessions.install(
			recommendationResponse(),
			recommendationContext(),
			1,
			true,
		);
		const runtime = {
			openLocation: vi.fn((options: { success(): void }) => options.success()),
			makePhoneCall: vi.fn((options: { success(): void }) => options.success()),
			setClipboardData: vi.fn((options: { success(): void }) =>
				options.success(),
			),
		};
		const events: string[] = [];
		const executor = new DetailActionExecutor(runtime, sessions, {
			record: (type) => events.push(type),
		});
		const token = recommendationResponse().results[0]?.resultToken ?? "";

		await expect(executor.navigate(token)).resolves.toBe(true);
		expect(runtime.openLocation).toHaveBeenCalledOnce();
		expect(events).toEqual(["NAVIGATION"]);

		sessions.expire();
		await expect(executor.call(token)).resolves.toBe(false);
		expect(runtime.makePhoneCall).not.toHaveBeenCalled();
		await expect(executor.share()).resolves.toBe(false);
	});
});

class FakeDecisionApi implements DecisionApi {
	readonly events: RecommendationEvent[] = [];
	readonly recommendations: RecommendationContext[] = [];

	searchLocation(_query: string): Promise<LocationSearchResponse> {
		return Promise.resolve(locationSearchResponse());
	}

	recommend(context: RecommendationContext): Promise<RecommendationResponse> {
		this.recommendations.push(context);
		return Promise.resolve(recommendationResponse());
	}

	recordEvent(event: RecommendationEvent): Promise<void> {
		this.events.push(event);
		return Promise.resolve();
	}
}

class FixedLocationProvider implements LocationProvider {
	currentLocation(): Promise<LocationChoice> {
		return Promise.resolve(manualLocation());
	}
}

class FailingLocationProvider implements LocationProvider {
	constructor(private readonly kind: "PERMISSION_PERMANENTLY_DENIED") {}

	currentLocation(): Promise<LocationChoice> {
		return Promise.reject(
			new LocationProviderError(this.kind, "定位权限已关闭，可手动选择地点"),
		);
	}
}

function trustedPolicy(generation: number) {
	return {
		generation,
		state: "TRUSTED_COMPATIBLE" as const,
		recommendationsEnabled: true,
		locationSearchEnabled: true,
		aiEnabled: true,
	};
}

function manualLocation(): LocationChoice {
	return {
		label: "北京大学东门",
		coordinate: {
			latitude: 39.9928,
			longitude: 116.3109,
			accuracyMeters: 80,
			crs: "WGS84",
		},
		isDemonstration: true,
		isApproximate: false,
	};
}

function recommendationContext(): RecommendationContext {
	return {
		location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
		locationLabel: "北京大学东门",
		mealPeriod: "LUNCH",
		decisionMode: "QUICK",
		travelMode: "WALK",
		explorationMode: "BALANCED",
		aiAssistanceEnabled: false,
		budgetMaxYuan: 50,
		availableMinutes: 60,
		radiusMeters: 1_500,
		partySize: 1,
		excludedCuisines: ["火锅"],
		preferredCuisines: [],
		requestTime: "2026-08-30T04:00:00.000Z",
	};
}

function recommendationResponse(): RecommendationResponse {
	return {
		requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
		generatedAt: "2026-08-30T04:00:00.000Z",
		coverage: "NATIONWIDE",
		dataRightsMode: "LIVE_DISPLAY_ONLY",
		ruleVersion: "rule-v1",
		promptVersion: "prompt-v1",
		modelVersion: "rule-fallback",
		aiFallbackUsed: false,
		results: [
			{
				provider: "DEMO",
				resultToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				dataMode: "DEMO",
				actions: { navigate: true, call: true, copyAddress: true, share: true },
				name: "演示面馆",
				address: "北京市海淀区测试路 1 号",
				rank: 1,
				fitScore: null,
				sourceRating: 4.5,
				averageCostYuan: 35,
				distanceMeters: 520,
				estimatedTravelMinutes: 8,
				estimatedMealMinutes: 22,
				openStatus: "OPEN",
				tags: ["面食"],
				imageUrl: null,
				phone: "+86 10 1234 5678",
				location: { latitude: 39.99, longitude: 116.31, crs: "WGS84" },
				reasons: [{ code: "TIME_FIT", text: "时间可行" }],
				warnings: ["营业时间请到店前确认"],
				confidence: "LOW",
				aiAssisted: false,
				sourceAttribution: "演示数据",
			},
		],
		notice: null,
	};
}

function responseWithResult(patch: Record<string, unknown>): unknown {
	const response = recommendationResponse();
	const first = response.results[0];
	if (first === undefined) throw new Error("test setup failed");
	return { ...response, results: [{ ...first, ...patch }] };
}

function locationSearchResponse(): LocationSearchResponse {
	return {
		requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
		dataSource: "DEMO",
		dataMode: "DEMO",
		results: [
			{
				name: "北京大学东门",
				address: "北京市海淀区",
				location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
				sourceLabel: "演示地点",
				providerRank: 1,
			},
		],
	};
}

function fixedNow(): Date {
	return new Date("2026-08-30T04:00:00.000Z");
}

function promiseWithResolvers<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
