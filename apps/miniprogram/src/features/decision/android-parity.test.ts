import { describe, expect, it, vi } from "vitest";
import {
	RecommendationContextSchema,
	RecommendationResponseSchema,
} from "../../../../../packages/contracts/src/index";
import { DISABLED_SPECIALTY_CAPABILITIES } from "../config/feature-config";
import {
	buildRecommendationContext,
	type DecisionAccessPolicy,
	type DecisionApi,
	DecisionController,
	DetailActionExecutor,
	defaultDecisionForm,
	parseRecommendationResponse,
	type RecommendationContext,
	type RecommendationResponse,
	ResultSessionStore,
	validateDecisionForm,
	WechatForegroundLocationProvider,
	type WechatLocationRuntime,
} from "./index";

const location = {
	label: "测试地点",
	coordinate: { latitude: 39.9, longitude: 116.4, crs: "WGS84" as const },
	isDemonstration: true,
	isApproximate: false,
};
const baseContext: RecommendationContext = {
	...buildRecommendationContext({ ...defaultDecisionForm(), location }, false),
	budgetMaxYuan: 50,
};
const policy: DecisionAccessPolicy = {
	generation: 1,
	state: "TRUSTED_COMPATIBLE",
	recommendationsEnabled: true,
	locationSearchEnabled: true,
	aiEnabled: true,
	dataRightsMode: "LICENSED_ENRICHMENT",
	specialtyCapabilities: {
		breakfastProfileEnabled: true,
		dinnerProfileEnabled: true,
		milkTeaEnabled: true,
		coffeeEnabled: true,
		dessertEnabled: true,
		userReportedWeatherEnabled: true,
	},
};

function response(): RecommendationResponse {
	return RecommendationResponseSchema.parse({
		requestId: "00000000-0000-4000-8000-000000000001",
		generatedAt: "2026-09-17T00:00:00.000Z",
		coverage: "NATIONWIDE",
		dataRightsMode: "LIVE_DISPLAY_ONLY",
		ruleVersion: "rules-v1",
		rulesConfigVersion: 4,
		promptVersion: "prompt-v1",
		modelVersion: "none",
		aiFallbackUsed: false,
		results: [
			{
				provider: "DEMO",
				resultToken: "a".repeat(43),
				dataMode: "DEMO",
				actions: {
					navigate: true,
					call: false,
					copyAddress: true,
					share: false,
				},
				name: "演示餐厅",
				address: "演示地址",
				rank: 1,
				fitScore: null,
				sourceRating: null,
				averageCostYuan: null,
				distanceMeters: 300,
				estimatedTravelMinutes: 10,
				estimatedMealMinutes: 30,
				openStatus: "UNKNOWN",
				tags: [],
				imageUrl: null,
				phone: null,
				location: location.coordinate,
				reasons: [{ code: "DISTANCE_FIT", text: "附近候选" }],
				warnings: [],
				confidence: "LOW",
				aiAssisted: false,
				sourceAttribution: "演示数据",
			},
		],
		notice: null,
	});
}

function controller() {
	const requests: RecommendationContext[] = [];
	const api: DecisionApi = {
		recommend: async (context) => {
			requests.push(context);
			return response();
		},
		searchLocation: vi.fn(),
		recordEvent: async () => undefined,
	};
	const value = new DecisionController(api, {
		currentLocation: async () => location,
	});
	value.setAccessPolicy(policy);
	value.setLocation(location);
	return { value, requests };
}

describe("current Android and shared wire parity", () => {
	it("accepts current contract output including profile, weather and rules version", () => {
		expect(RecommendationContextSchema.safeParse(baseContext).success).toBe(
			true,
		);
		expect(
			parseRecommendationResponse(response(), baseContext).rulesConfigVersion,
		).toBe(4);
	});

	it.each([
		["MEAL", "BREAKFAST", "MEAL_BREAKFAST", "meal-breakfast", false],
		["MEAL", "LUNCH", "MEAL_LUNCH", "meal-lunch", false],
		["MEAL", "DINNER", "MEAL_DINNER", "meal-dinner", false],
		["MILK_TEA", "LUNCH", "MILK_TEA", "milk-tea", true],
		["COFFEE", "LUNCH", "COFFEE", "coffee", true],
		["DESSERT", "LUNCH", "DESSERT", "dessert", true],
	] as const)(
		"verifies the %s / %s profile against request evidence",
		(target, mealPeriod, family, prefix, required) => {
			const profile = {
				target,
				family,
				version: `${prefix}-v1`,
				providerCapabilityRequired: required,
			};
			const context = { ...baseContext, target, mealPeriod };
			expect(
				parseRecommendationResponse({ ...response(), profile }, context)
					.profile,
			).toEqual(profile);
			expect(() =>
				parseRecommendationResponse(
					{
						...response(),
						profile: { ...profile, providerCapabilityRequired: !required },
					},
					context,
				),
			).toThrow();
			expect(() =>
				parseRecommendationResponse(
					{ ...response(), profile: { ...profile, version: "incorrect-v1" } },
					context,
				),
			).toThrow();
		},
	);

	it("allows legacy evidence only for ordinary lunch and rejects missing specialty evidence", () => {
		const legacy = { ...response() };
		delete legacy.profile;
		delete legacy.weatherApplication;
		expect(
			parseRecommendationResponse(legacy, baseContext).profile?.family,
		).toBe("MEAL_LEGACY");
		expect(() =>
			parseRecommendationResponse(legacy, {
				...baseContext,
				mealPeriod: "DINNER",
			}),
		).toThrow();
		expect(() =>
			parseRecommendationResponse(response(), {
				...baseContext,
				target: "COFFEE",
			}),
		).toThrow();
	});

	it.each([
		["MINIMIZE_EXPOSURE", "MINIMIZE_OUTDOOR_EXPOSURE"],
		["WARMING", "PREFER_WARMING_OPTIONS"],
		["COOLING", "PREFER_COOLING_OPTIONS"],
	] as const)(
		"binds %s weather evidence to its exact query modifier",
		(preference, queryModifier) => {
			const context = {
				...baseContext,
				weatherContext: { kind: "USER_REPORTED" as const, preference },
			};
			const result = {
				...response(),
				profile: {
					target: "MEAL",
					family: "MEAL_LUNCH",
					version: "meal-lunch-v1",
					providerCapabilityRequired: false,
				},
				weatherApplication: {
					kind: "USER_REPORTED",
					version: "user-reported-weather-v1",
					preference,
					queryModifier,
				},
			};
			expect(
				parseRecommendationResponse(result, context).weatherApplication?.kind,
			).toBe("USER_REPORTED");
			expect(() =>
				parseRecommendationResponse(
					{
						...result,
						weatherApplication: {
							...result.weatherApplication,
							queryModifier: null,
						},
					},
					context,
				),
			).toThrow();
			expect(() => parseRecommendationResponse(result, baseContext)).toThrow();
		},
	);

	it("rejects disabled AI claims, known conflicts and grouped cuisine conflicts", () => {
		expect(() =>
			parseRecommendationResponse(
				{ ...response(), aiFallbackUsed: true },
				baseContext,
			),
		).toThrow();
		const first = response().results[0];
		for (const patch of [
			{ averageCostYuan: 51 },
			{ openStatus: "CLOSED" },
			{ distanceMeters: 1_501 },
			{ tags: ["经典川菜"] },
			{ tags: ["湖南湘菜"] },
		]) {
			expect(() =>
				parseRecommendationResponse(
					{ ...response(), results: [{ ...first, ...patch }] },
					{ ...baseContext, excludedCuisines: ["川湘菜"] },
				),
			).toThrow();
		}
		// Estimated time is a soft signal; null cost and unknown opening do not become hard facts.
		expect(
			parseRecommendationResponse(
				{ ...response(), results: [{ ...first, estimatedMealMinutes: 180 }] },
				baseContext,
			).results,
		).toHaveLength(1);
	});

	it("keeps one person and rejects forged or malformed request inputs", () => {
		const form = { ...defaultDecisionForm(), location };
		expect(validateDecisionForm({ ...form, partySize: 2 }).valid).toBe(false);
		expect(
			validateDecisionForm({
				...form,
				preferenceVector: { ...form.preferenceVector, budget: 101 },
			}).valid,
		).toBe(false);
		expect(
			validateDecisionForm({
				...form,
				location: {
					...location,
					coordinate: { ...location.coordinate, latitude: Number.NaN },
				},
			}).valid,
		).toBe(false);
		const { value } = controller();
		value.setPartySize(30);
		expect(value.state.form.partySize).toBe(1);
	});

	it("preserves explicit radius and cuisine/location choices across scenarios and configuration refresh", async () => {
		const { value, requests } = controller();
		value.toggleCuisine("川湘菜", false);
		value.applyScenario("IN_A_HURRY");
		expect(value.state.form).toMatchObject({
			location,
			radiusMeters: 1_000,
			availableMinutes: 30,
			excludedCuisines: ["川湘菜"],
		});
		expect(value.state.activeScenario).toBe("IN_A_HURRY");
		value.setAccessPolicy({
			...policy,
			generation: 2,
			recommendationDefaults: {
				areaCode: "NATIONWIDE",
				defaultRadiusMeters: 300,
				maximumRadiusMeters: 500,
			},
		});
		expect(value.state.form.radiusMeters).toBe(1_000);
		await expect(value.recommend()).resolves.toBe(false);
		expect(requests).toHaveLength(0);
		expect(value.state.formError).toContain("500");
	});

	it("applies automatic defaults until a radius is explicitly selected", () => {
		const { value } = controller();
		value.setAccessPolicy({
			...policy,
			generation: 2,
			recommendationDefaults: {
				areaCode: "NATIONWIDE",
				defaultRadiusMeters: 700,
				maximumRadiusMeters: 900,
			},
		});
		expect(value.state.form.radiusMeters).toBe(700);
		value.setRadius(800);
		value.setMealPeriod("DINNER");
		expect(value.state.form.radiusMeters).toBe(800);
	});

	it("keeps a disabled specialty draft visible and blocks it instead of silently falling back", async () => {
		const { value, requests } = controller();
		value.setRecommendationTarget("COFFEE");
		value.setAccessPolicy({
			...policy,
			generation: 2,
			specialtyCapabilities: DISABLED_SPECIALTY_CAPABILITIES,
		});
		expect(value.state.form.target).toBe("COFFEE");
		await expect(value.recommend()).resolves.toBe(false);
		expect(requests).toHaveLength(0);
		value.setRecommendationTarget("MEAL");
		await expect(value.recommend()).resolves.toBe(true);
	});

	it("limits AI to ordinary lunch and ignores inactive soft weights in display-only mode", async () => {
		const { value, requests } = controller();
		value.setPreferenceWeight("budget", 0);
		value.setRecommendationTarget("COFFEE");
		await value.recommend();
		expect(requests[0]?.aiAssistanceEnabled).toBe(false);
		value.setRecommendationTarget("MEAL");
		value.setAccessPolicy({
			...policy,
			generation: 2,
			dataRightsMode: "LIVE_DISPLAY_ONLY",
		});
		await value.recommend();
		expect(requests[1]?.preferenceVector?.budget).toBe(100);
	});
});

describe("request-scoped result lifetime", () => {
	it("expires through the platform timer even when wall time is moved backward without intermediate reads", () => {
		let wall = Date.parse("2026-09-17T00:00:00.000Z");
		let expire = () => undefined;
		const sessions = new ResultSessionStore(
			() => new Date(wall),
			(callback, delay) => {
				expect(delay).toBe(2 * 60 * 60 * 1_000);
				expire = callback;
				return () => undefined;
			},
		);
		sessions.confirmConfiguration(1);
		sessions.install(response(), baseContext, 1, true);
		// Two real hours pass; the system clock was turned back during that gap.
		wall += 60 * 60 * 1_000;
		expire();
		expect(sessions.currentResponse()).toBeNull();
	});

	it("rejects partial wall-clock rollback and cancels timers on withdrawal", () => {
		let wall = Date.parse("2026-09-17T00:00:00.000Z");
		const cancel = vi.fn();
		const sessions = new ResultSessionStore(
			() => new Date(wall),
			() => cancel,
		);
		sessions.confirmConfiguration(1);
		sessions.install(response(), baseContext, 1, true);
		wall += 110 * 60 * 1_000;
		expect(sessions.currentResponse()).not.toBeNull();
		wall -= 60 * 60 * 1_000;
		expect(sessions.currentResponse()).toBeNull();
		expect(cancel).toHaveBeenCalledOnce();
		sessions.install(response(), baseContext, 1, true);
		sessions.expire();
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	it("expires after two hours even while remaining in the foreground", async () => {
		let time = Date.parse("2026-09-17T00:00:00.000Z");
		const sessions = new ResultSessionStore(() => new Date(time));
		sessions.confirmConfiguration(1);
		sessions.install(response(), baseContext, 1, true);
		const token = response().results[0]?.resultToken ?? "";
		expect(sessions.select(token)).toBe(true);
		time += 2 * 60 * 60 * 1_000 - 1;
		expect(sessions.state(token)).toBe("CURRENT");
		time += 1;
		const runtime = {
			openLocation: vi.fn(),
			makePhoneCall: vi.fn(),
			setClipboardData: vi.fn(),
		};
		const actions = new DetailActionExecutor(runtime, sessions, {
			record: vi.fn(),
		});
		await expect(actions.navigate(token)).resolves.toBe(false);
		expect(runtime.openLocation).not.toHaveBeenCalled();
		expect(sessions.selected()).toBeNull();
		expect(sessions.currentResponse()).toBeNull();
	});

	it("does not extend a server result lifetime by delaying receipt or rolling the local clock back", () => {
		let time = Date.parse("2026-09-17T01:50:00.000Z");
		const sessions = new ResultSessionStore(() => new Date(time));
		sessions.confirmConfiguration(1);
		sessions.install(response(), baseContext, 1, true);
		time += 10 * 60 * 1_000;
		expect(sessions.currentResponse()).toBeNull();
		time = Date.parse("2026-09-17T00:00:00.000Z");
		sessions.install(response(), baseContext, 1, true);
		time -= 1;
		expect(sessions.currentResponse()).toBeNull();
	});
});

describe("WeChat platform privacy and foreground location", () => {
	it("requires platform privacy API even after custom consent", async () => {
		const getLocation = vi.fn();
		await expect(
			new WechatForegroundLocationProvider(
				{ getLocation },
				() => true,
			).currentLocation(),
		).rejects.toMatchObject({ kind: "PRIVACY_REQUIRED" });
		expect(getLocation).not.toHaveBeenCalled();
	});

	it("does not locate when authority closes while platform authorization is pending", async () => {
		let authorize = () => undefined;
		let allowed = true;
		const getLocation = vi.fn();
		const provider = new WechatForegroundLocationProvider(
			{
				requirePrivacyAuthorize: (options) => {
					authorize = options.success;
				},
				getLocation,
			},
			() => allowed,
		);
		const pending = provider.currentLocation();
		allowed = false;
		authorize();
		await expect(pending).rejects.toMatchObject({ kind: "CANCELLED" });
		expect(getLocation).not.toHaveBeenCalled();
	});

	it("cancels pending authorization and discards a late location after backgrounding", async () => {
		let acceptLocation: Parameters<
			WechatLocationRuntime["getLocation"]
		>[0]["success"] = () => undefined;
		const provider = new WechatForegroundLocationProvider(
			{
				requirePrivacyAuthorize: (options) => options.success(),
				getLocation: (options) => {
					acceptLocation = options.success;
				},
			},
			() => true,
		);
		const pending = provider.currentLocation();
		await Promise.resolve();
		provider.cancel();
		acceptLocation({ latitude: 39.9, longitude: 116.4 });
		await expect(pending).rejects.toMatchObject({ kind: "CANCELLED" });
	});
});
