import { describe, expect, it } from "vitest";
import {
	AccountExportResponseSchema,
	AccountExportStatusResponseSchema,
	AuthCapabilitiesSchema,
	AuthTokenResponseSchema,
	BindIdentityRequestSchema,
	CONTRACT_VERSION_HEADER,
	CoordinateSchema,
	CreatePrivateFeedbackRequestSchema,
	CURRENT_CONTRACT_VERSION,
	EmailRequestCodeSchema,
	FavoriteMutationRequestSchema,
	FavoriteRecordSchema,
	FeatureConfigSchema,
	IdentityBindingSchema,
	LatestAccountExportResponseSchema,
	ListFavoritesQuerySchema,
	ListPrivateFeedbackQuerySchema,
	ListRecommendationHistoryQuerySchema,
	LocationSearchRequestSchema,
	LocationSearchResponseSchema,
	LoginRequestSchema,
	OAuthStateRequestSchema,
	PhoneRequestCodeSchema,
	PlaceSearchRequestSchema,
	PlaceSearchResponseSchema,
	PRIVATE_FEEDBACK_STORAGE_TYPE_BY_PUBLIC_TYPE,
	PrivateFeedbackRecordSchema,
	PrivateFeedbackTypeSchema,
	RECOMMENDATION_HISTORY_STORAGE_EVENT_BY_ACTION,
	RecommendationContextSchema,
	RecommendationEventSchema,
	RecommendationHistoryItemSchema,
	RecommendationProfileSchema,
	RecommendationResponseSchema,
	RecommendationResultSchema,
	RecommendationTargetSchema,
	ServiceCapabilitiesSchema,
	SpecialtyCapabilitiesSchema,
	SupportFeedbackCategorySchema,
	SupportFeedbackRequestSchema,
	SupportFeedbackResponseSchema,
	UpdateFavoriteGroupRequestSchema,
	WeatherApplicationSchema,
	WeatherContextRequestSchema,
} from "./index.js";

const VALID_RESULT_TOKEN = "A".repeat(43);
const VALID_UUID = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
const VALID_IDEMPOTENCY_KEY = "9fb5827d-050d-4e7c-ad29-1b67ee92e01b";

describe("HTTP compatibility contract", () => {
	it("exports a stable major contract version and header name", () => {
		expect(CONTRACT_VERSION_HEADER).toBe("X-ChiShenMe-Contract-Version");
		expect(CURRENT_CONTRACT_VERSION).toBe("1");
	});
});

describe("Support feedback contracts", () => {
	it("accepts only the fixed categories and a UUIDv4 submission id", () => {
		expect(SupportFeedbackCategorySchema.options).toEqual([
			"PRODUCT",
			"PLACE_CORRECTION",
			"PRIVACY",
			"COMPLAINT",
		]);
		expect(
			SupportFeedbackRequestSchema.safeParse({
				submissionId: VALID_UUID,
				category: "PRODUCT",
				message: "这是足够长的产品反馈内容。",
			}).success,
		).toBe(true);
		expect(
			SupportFeedbackRequestSchema.safeParse({
				submissionId: "2af305ae-82a1-3f87-86b7-1c97c4a8683f",
				category: "PRODUCT",
				message: "这是足够长的产品反馈内容。",
			}).success,
		).toBe(false);
	});

	it("counts Unicode code points, normalizes newlines, and rejects controls", () => {
		expect(
			SupportFeedbackRequestSchema.parse({
				submissionId: VALID_UUID,
				category: "COMPLAINT",
				message: `  ${"🍜".repeat(10)}\r\n补充内容  `,
			}).message,
		).toBe(`${"🍜".repeat(10)}\n补充内容`);
		for (const message of [
			"🍜".repeat(9),
			"好".repeat(2_001),
			"这是足够长但包含\u0000控制字符的反馈",
		]) {
			expect(
				SupportFeedbackRequestSchema.safeParse({
					submissionId: VALID_UUID,
					category: "PRODUCT",
					message,
				}).success,
			).toBe(false);
		}
	});

	it("keeps the accepted response minimal and strict", () => {
		const response = {
			feedbackId: VALID_UUID,
			accepted: true,
			retentionAfterClosureDays: 180,
		};
		expect(SupportFeedbackResponseSchema.safeParse(response).success).toBe(
			true,
		);
		expect(
			SupportFeedbackResponseSchema.safeParse({
				...response,
				fingerprintKeyVersion: "must-not-leak",
			}).success,
		).toBe(false);
	});
});

describe("Recommendation contracts", () => {
	it("accepts a privacy-minimal recommendation context", () => {
		const result = RecommendationContextSchema.safeParse({
			location: { latitude: 39.9928, longitude: 116.3109, accuracyMeters: 80 },
			mealPeriod: "LUNCH",
			radiusMeters: 1_500,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.aiAssistanceEnabled).toBe(true);
			expect(result.data.location.crs).toBe("WGS84");
			expect(result.data.target).toBe("MEAL");
			expect(result.data.weatherContext).toEqual({ kind: "NONE" });
			expect(result.data.preferenceVector).toEqual({
				quality: 100,
				time: 100,
				budget: 100,
				mealMatch: 100,
				diversity: 100,
			});
		}
	});

	it("accepts only fixed targets and a strict user-reported weather union", () => {
		expect(RecommendationTargetSchema.options).toEqual([
			"MEAL",
			"MILK_TEA",
			"COFFEE",
			"DESSERT",
		]);
		expect(
			WeatherContextRequestSchema.parse({
				kind: "USER_REPORTED",
				preference: "MINIMIZE_EXPOSURE",
			}),
		).toEqual({
			kind: "USER_REPORTED",
			preference: "MINIMIZE_EXPOSURE",
		});
		for (const weatherContext of [
			{ kind: "NONE", preference: "WARMING" },
			{ kind: "USER_REPORTED" },
			{ kind: "USER_REPORTED", preference: "RAIN" },
			{ kind: "PROVIDER_OBSERVED", preference: "COOLING" },
			{
				kind: "USER_REPORTED",
				preference: "COOLING",
				temperatureCelsius: 31,
			},
		]) {
			expect(
				WeatherContextRequestSchema.safeParse(weatherContext).success,
			).toBe(false);
		}
	});

	it("keeps the v1 request's top-level unknown-field stripping semantics", () => {
		const request = {
			location: { latitude: 39.9928, longitude: 116.3109 },
			mealPeriod: "DINNER",
			radiusMeters: 1_500,
		};
		expect(
			RecommendationContextSchema.safeParse({
				...request,
				target: "COFFEE",
				weatherContext: {
					kind: "USER_REPORTED",
					preference: "WARMING",
				},
			}).success,
		).toBe(true);
		const legacyCompatible = RecommendationContextSchema.parse({
			...request,
			weatherSource: "provider",
		});
		expect(legacyCompatible).not.toHaveProperty("weatherSource");
	});

	it("defaults old responses only to the legacy meal and no-weather profiles", () => {
		const parsed = RecommendationResponseSchema.parse({
			requestId: VALID_UUID,
			generatedAt: "2026-09-03T00:00:00.000Z",
			coverage: "NATIONWIDE",
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			ruleVersion: "recommendation-rules-v2",
			promptVersion: "recommendation-prompt-v1",
			modelVersion: "rule-fallback-v1",
			aiFallbackUsed: true,
			results: [],
			notice: null,
		});
		expect(parsed.profile).toEqual({
			target: "MEAL",
			family: "MEAL_LEGACY",
			version: "meal-legacy-v1",
			providerCapabilityRequired: false,
		});
		expect(parsed.weatherApplication).toEqual({
			kind: "NONE",
			version: "weather-none-v1",
			queryModifier: null,
		});
	});

	it("enforces exact profile and weather-application mappings", () => {
		expect(
			RecommendationProfileSchema.safeParse({
				target: "MILK_TEA",
				family: "MILK_TEA",
				version: "milk-tea-v2",
				providerCapabilityRequired: true,
			}).success,
		).toBe(true);
		for (const profile of [
			{
				target: "MILK_TEA",
				family: "MILK_TEA",
				version: "milk-tea-v1",
				providerCapabilityRequired: false,
			},
			{
				target: "MILK_TEA",
				family: "MEAL_LUNCH",
				version: "meal-lunch-v1",
				providerCapabilityRequired: false,
			},
			{
				target: "COFFEE",
				family: "COFFEE",
				version: "milk-tea-v2",
				providerCapabilityRequired: true,
			},
			{
				target: "DESSERT",
				family: "DESSERT",
				version: "dessert-v1",
				providerCapabilityRequired: true,
				providerTaxonomy: "unapproved",
			},
		]) {
			expect(RecommendationProfileSchema.safeParse(profile).success).toBe(
				false,
			);
		}

		expect(
			WeatherApplicationSchema.safeParse({
				kind: "USER_REPORTED",
				version: "user-reported-weather-v2",
				preference: "COOLING",
				queryModifier: "PREFER_COOLING_OPTIONS",
			}).success,
		).toBe(true);
		expect(
			WeatherApplicationSchema.safeParse({
				kind: "USER_REPORTED",
				version: "user-reported-weather-v1",
				preference: "WARMING",
				queryModifier: "PREFER_COOLING_OPTIONS",
			}).success,
		).toBe(false);
		expect(
			WeatherApplicationSchema.safeParse({
				kind: "NONE",
				version: "weather-none-v1",
				queryModifier: null,
				rawTemperature: 31,
			}).success,
		).toBe(false);
	});

	it("accepts only a complete bounded preference vector", () => {
		const request = {
			location: { latitude: 39.9928, longitude: 116.3109 },
			mealPeriod: "LUNCH",
			radiusMeters: 1_500,
		};
		expect(
			RecommendationContextSchema.safeParse({
				...request,
				preferenceVector: {
					quality: 80,
					time: 100,
					budget: 55,
					mealMatch: 70,
					diversity: 25,
				},
			}).success,
		).toBe(true);
		for (const preferenceVector of [
			{ quality: -1, time: 100, budget: 100, mealMatch: 100, diversity: 100 },
			{ quality: 100, time: 101, budget: 100, mealMatch: 100, diversity: 100 },
			{ quality: 100, time: 100, budget: 2.5, mealMatch: 100, diversity: 100 },
			{ quality: 100, time: 100, budget: 100, mealMatch: 100 },
			{
				quality: 100,
				time: 100,
				budget: 100,
				mealMatch: 100,
				diversity: 100,
				locationHistory: true,
			},
		]) {
			expect(
				RecommendationContextSchema.safeParse({ ...request, preferenceVector })
					.success,
			).toBe(false);
		}
	});

	it("defaults legacy coordinates to WGS84 and preserves explicit GCJ02", () => {
		expect(
			CoordinateSchema.parse({ latitude: 39.9, longitude: 116.4 }).crs,
		).toBe("WGS84");
		expect(
			CoordinateSchema.parse({ latitude: 39.9, longitude: 116.4, crs: "GCJ02" })
				.crs,
		).toBe("GCJ02");
		expect(
			CoordinateSchema.safeParse({
				latitude: 39.9,
				longitude: 116.4,
				crs: "BD09",
			}).success,
		).toBe(false);
	});

	it("accepts an authorized provider code without vendor-specific public rules", () => {
		const common = {
			provider: "AUTHORIZED_VENDOR",
			resultToken: VALID_RESULT_TOKEN,
			dataMode: "LIVE",
			actions: {
				navigate: true,
				call: false,
				copyAddress: true,
				share: false,
			},
			name: "测试餐厅",
			address: "测试地址",
			rank: 1,
			fitScore: null,
			sourceRating: null,
			averageCostYuan: null,
			distanceMeters: 100,
			estimatedTravelMinutes: 2,
			estimatedMealMinutes: 30,
			openStatus: "UNKNOWN",
			tags: ["面食"],
			imageUrl: null,
			phone: null,
			reasons: [{ code: "DISTANCE_FIT", text: "距离较近" }],
			warnings: [],
			confidence: "LOW",
			aiAssisted: false,
			sourceAttribution: "已授权数据源",
		};
		expect(
			RecommendationResultSchema.safeParse({
				...common,
				location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" },
			}).success,
		).toBe(true);
		expect(
			RecommendationResultSchema.safeParse({
				...common,
				provider: "invalid-provider",
				location: { latitude: 39.901, longitude: 116.406, crs: "GCJ02" },
			}).success,
		).toBe(false);

		expect(
			RecommendationResultSchema.safeParse({
				...common,
				actions: { ...common.actions, unsupported: true },
				location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" },
			}).success,
		).toBe(false);
		expect(
			RecommendationResultSchema.safeParse({
				...common,
				resultToken: "not-base64url",
				location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" },
			}).success,
		).toBe(false);
		const parsed = RecommendationResultSchema.parse({
			...common,
			providerPlaceId: "must-not-cross-public-contract",
			location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" },
		});
		expect(parsed).not.toHaveProperty("providerPlaceId");
	});

	it("preserves an explicit AI opt-out", () => {
		const result = RecommendationContextSchema.parse({
			location: { latitude: 39.9928, longitude: 116.3109 },
			mealPeriod: "LUNCH",
			radiusMeters: 1_500,
			aiAssistanceEnabled: false,
		});
		expect(result.aiAssistanceEnabled).toBe(false);
	});

	it("rejects free-form text in model-bound cuisine fields", () => {
		const result = RecommendationContextSchema.safeParse({
			location: { latitude: 39.9928, longitude: 116.3109 },
			mealPeriod: "LUNCH",
			radiusMeters: 1_500,
			preferredCuisines: ["手机号13800138000"],
		});
		expect(result.success).toBe(false);
	});

	it("rejects coordinates in analytics events", () => {
		const result = RecommendationEventSchema.safeParse({
			requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
			resultToken: VALID_RESULT_TOKEN,
			type: "DETAIL",
			occurredAt: new Date().toISOString(),
			latitude: 39.9,
		});
		expect(result.success).toBe(false);
	});

	it("accepts only opaque result references in analytics events", () => {
		const event = {
			requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
			resultToken: VALID_RESULT_TOKEN,
			type: "DETAIL",
			occurredAt: new Date().toISOString(),
		};
		expect(RecommendationEventSchema.safeParse(event).success).toBe(true);
		expect(
			RecommendationEventSchema.safeParse({
				...event,
				provider: "AUTHORIZED_VENDOR",
				providerPlaceId: "authorized-1",
			}).success,
		).toBe(false);
		expect(
			RecommendationEventSchema.safeParse({
				...event,
				resultToken: `${VALID_RESULT_TOKEN}=`,
			}).success,
		).toBe(false);
	});
});

describe("Private persisted recommendation contracts", () => {
	const resultReference = {
		requestId: VALID_UUID,
		resultToken: VALID_RESULT_TOKEN,
	};
	const availablePresentation = {
		presentationStatus: "AVAILABLE" as const,
		name: "测试餐厅",
		address: "测试地址",
		sourceLabel: "授权数据源实时信息",
		dataMode: "LIVE" as const,
		openStatus: "UNKNOWN" as const,
		averageCostYuan: null,
		tags: ["简餐"],
		resolvedAt: "2026-08-21T04:00:00.000Z",
	};

	it("uses only a live result proof to create a favorite and carries idempotency", () => {
		expect(
			FavoriteMutationRequestSchema.safeParse({
				idempotencyKey: VALID_IDEMPOTENCY_KEY,
				result: resultReference,
				group: "WANT_TO_GO",
			}).success,
		).toBe(true);
		expect(
			FavoriteMutationRequestSchema.safeParse({
				idempotencyKey: VALID_IDEMPOTENCY_KEY,
				result: {
					kind: "PLACE_RESOURCE",
					placeResourceId: VALID_UUID,
				},
				group: "REGULAR",
			}).success,
		).toBe(false);
		expect(
			FavoriteMutationRequestSchema.safeParse({
				result: resultReference,
				group: "REGULAR",
			}).success,
		).toBe(false);
		expect(
			UpdateFavoriteGroupRequestSchema.safeParse({
				idempotencyKey: VALID_IDEMPOTENCY_KEY,
				group: "REGULAR",
			}).success,
		).toBe(true);
	});

	it("returns useful live presentations without durable provider identifiers", () => {
		const favorite = {
			favoriteId: VALID_UUID,
			group: "REGULAR",
			createdAt: "2026-08-21T03:00:00.000Z",
			presentation: availablePresentation,
		};
		expect(FavoriteRecordSchema.safeParse(favorite).success).toBe(true);
		expect(
			FavoriteRecordSchema.safeParse({
				...favorite,
				providerPlaceId: "provider-123",
			}).success,
		).toBe(false);
		expect(
			FavoriteRecordSchema.safeParse({
				...favorite,
				presentation: {
					...availablePresentation,
					latitude: 39.9,
				},
			}).success,
		).toBe(false);
		expect(
			FavoriteRecordSchema.safeParse({
				...favorite,
				presentation: {
					presentationStatus: "RIGHTS_REVOKED",
					retryable: false,
				},
			}).success,
		).toBe(true);
	});

	it("parses only canonical bounded page limits from HTTP query strings", () => {
		expect(ListFavoritesQuerySchema.parse({}).limit).toBe(20);
		expect(ListFavoritesQuerySchema.parse({ limit: "50" }).limit).toBe(50);
		for (const limit of ["0", "01", "51", "1e1", " 10", 10, ["10", "20"]]) {
			expect(ListFavoritesQuerySchema.safeParse({ limit }).success).toBe(false);
			expect(
				ListRecommendationHistoryQuerySchema.safeParse({ limit }).success,
			).toBe(false);
			expect(ListPrivateFeedbackQuerySchema.safeParse({ limit }).success).toBe(
				false,
			);
		}
	});

	it("keeps history action-only and enforces the 90-day raw retention window", () => {
		const occurredAt = "2026-01-01T00:00:00.000Z";
		const expiresAt = new Date(
			Date.parse(occurredAt) + 90 * 24 * 60 * 60 * 1_000,
		).toISOString();
		const history = {
			historyId: VALID_UUID,
			action: "NAVIGATION_OPENED",
			mealPeriod: "LUNCH",
			occurredAt,
			expiresAt,
			presentation: availablePresentation,
		};
		expect(RecommendationHistoryItemSchema.safeParse(history).success).toBe(
			true,
		);
		expect(
			RecommendationHistoryItemSchema.safeParse({
				...history,
				action: "ARRIVED",
			}).success,
		).toBe(false);
		expect(
			RecommendationHistoryItemSchema.safeParse({
				...history,
				expiresAt: "2026-04-02T00:00:00.000Z",
			}).success,
		).toBe(false);
		expect(RECOMMENDATION_HISTORY_STORAGE_EVENT_BY_ACTION).toEqual({
			RECOMMENDATION_SHOWN: "IMPRESSION",
			DETAIL_VIEWED: "DETAIL",
			FAVORITE_ADDED: "FAVORITE",
			NAVIGATION_OPENED: "NAVIGATION",
			PHONE_DIALER_OPENED: "CALL",
			REROLL_REQUESTED: "REROLL",
		});
	});

	it("freezes all private feedback values and their explicit DB translation", () => {
		expect(PrivateFeedbackTypeSchema.options).toEqual([
			"WANT_TO_EAT",
			"ATE",
			"LIKE",
			"DISLIKE",
			"TOO_FAR",
			"TOO_EXPENSIVE",
			"RECENTLY_ATE",
			"AVOID_CUISINE",
		]);
		expect(PRIVATE_FEEDBACK_STORAGE_TYPE_BY_PUBLIC_TYPE).toEqual({
			WANT_TO_EAT: "WANT_TO_EAT",
			ATE: "ATE",
			LIKE: "LIKE",
			DISLIKE: "DISLIKE",
			TOO_FAR: "TOO_FAR",
			TOO_EXPENSIVE: "TOO_EXPENSIVE",
			RECENTLY_ATE: "ATE_RECENTLY",
			AVOID_CUISINE: "EXCLUDE_CUISINE",
		});
		expect(
			CreatePrivateFeedbackRequestSchema.safeParse({
				idempotencyKey: VALID_IDEMPOTENCY_KEY,
				result: resultReference,
				type: "AVOID_CUISINE",
			}).success,
		).toBe(true);
		expect(
			PrivateFeedbackRecordSchema.safeParse({
				feedbackId: VALID_UUID,
				type: "LIKE",
				visibility: "PRIVATE",
				createdAt: "2026-08-21T04:00:00.000Z",
				presentation: null,
				resultToken: VALID_RESULT_TOKEN,
			}).success,
		).toBe(false);
	});

	it("fails persistence capabilities closed in live-display-only mode", () => {
		const base = {
			coverageName: "全国范围",
			dataRightsMode: "LIVE_DISPLAY_ONLY" as const,
			aiEnabled: false,
			accountsEnabled: true,
			favoritesEnabled: false,
			minimumSupportedVersion: "0.1.0",
			ruleVersion: "rule-v1",
			promptVersion: "prompt-v1",
			modelVersion: "rules",
		};
		expect(FeatureConfigSchema.safeParse(base).success).toBe(true);
		expect(
			FeatureConfigSchema.safeParse({
				...base,
				persistenceCapabilities: {
					favoritesEnabled: false,
					historyEnabled: true,
					privateFeedbackEnabled: false,
					savedResourceIdsEnabled: false,
				},
			}).success,
		).toBe(false);
	});

	it("fails support feedback closed for older responses and keeps the config strict", () => {
		const base = {
			coverageName: "全国范围",
			dataRightsMode: "LIVE_DISPLAY_ONLY" as const,
			aiEnabled: false,
			accountsEnabled: false,
			favoritesEnabled: false,
			minimumSupportedVersion: "0.1.0",
			ruleVersion: "rule-v1",
			promptVersion: "prompt-v1",
			modelVersion: "rules",
		};

		expect(FeatureConfigSchema.parse(base).supportFeedbackEnabled).toBe(false);
		expect(
			FeatureConfigSchema.parse({ ...base, supportFeedbackEnabled: true })
				.supportFeedbackEnabled,
		).toBe(true);
		expect(
			FeatureConfigSchema.safeParse({ ...base, supportFeedbackEnabled: "true" })
				.success,
		).toBe(false);
		expect(
			FeatureConfigSchema.safeParse({ ...base, unknownCapability: true })
				.success,
		).toBe(false);
	});

	it("fails every provider capability closed for older or partial config responses", () => {
		const base = {
			coverageName: "全国范围",
			dataRightsMode: "LIVE_DISPLAY_ONLY" as const,
			aiEnabled: false,
			accountsEnabled: false,
			favoritesEnabled: false,
			minimumSupportedVersion: "0.1.0",
			ruleVersion: "rule-v1",
			promptVersion: "prompt-v1",
			modelVersion: "rules",
		};

		expect(FeatureConfigSchema.parse(base).serviceCapabilities).toEqual({
			recommendationsEnabled: false,
			locationSearchEnabled: false,
			placeSearchEnabled: false,
		});
		expect(
			ServiceCapabilitiesSchema.parse({ recommendationsEnabled: true }),
		).toEqual({
			recommendationsEnabled: true,
			locationSearchEnabled: false,
			placeSearchEnabled: false,
		});
		expect(
			ServiceCapabilitiesSchema.safeParse({
				recommendationsEnabled: true,
				locationSearchEnabled: true,
				placeSearchEnabled: true,
				providerCode: "AMAP",
			}).success,
		).toBe(false);
	});

	it("accepts specialty capabilities only as a complete strict atomic object", () => {
		const base = {
			coverageName: "全国范围",
			dataRightsMode: "LIVE_DISPLAY_ONLY" as const,
			aiEnabled: false,
			accountsEnabled: false,
			favoritesEnabled: false,
			minimumSupportedVersion: "0.1.0",
			ruleVersion: "rule-v1",
			promptVersion: "prompt-v1",
			modelVersion: "rules",
		};
		const complete = {
			breakfastProfileEnabled: true,
			dinnerProfileEnabled: true,
			milkTeaEnabled: false,
			coffeeEnabled: false,
			dessertEnabled: false,
			userReportedWeatherEnabled: false,
		};

		expect(
			FeatureConfigSchema.parse(base).specialtyCapabilities,
		).toBeUndefined();
		expect(SpecialtyCapabilitiesSchema.parse(complete)).toEqual(complete);
		expect(
			FeatureConfigSchema.parse({
				...base,
				specialtyCapabilities: complete,
			}).specialtyCapabilities,
		).toEqual(complete);
		expect(
			FeatureConfigSchema.safeParse({
				...base,
				specialtyCapabilities: {
					breakfastProfileEnabled: true,
				},
			}).success,
		).toBe(false);
		expect(
			SpecialtyCapabilitiesSchema.safeParse({
				...complete,
				providerCode: "DEMO",
			}).success,
		).toBe(false);
		expect(
			SpecialtyCapabilitiesSchema.safeParse({
				...complete,
				coffeeEnabled: "true",
			}).success,
		).toBe(false);
	});
});

describe("Location search contracts", () => {
	it("trims a safe, user-entered place query", () => {
		expect(
			LocationSearchRequestSchema.parse({ query: "  北京大学东门  " }),
		).toEqual({
			query: "北京大学东门",
		});
	});

	it.each([
		"116.3109,39.9928",
		"39.9928,116.3109",
		"地点|餐厅",
		"联系 13800138000",
		"联系 138 0013 8000",
		"test@example.com",
		"地点\u0000名称",
	])("rejects sensitive or provider-control-shaped input: %s", (query) => {
		expect(LocationSearchRequestSchema.safeParse({ query }).success).toBe(
			false,
		);
	});

	it("strictly rejects undeclared location and identity fields", () => {
		expect(
			LocationSearchRequestSchema.safeParse({
				query: "五道口",
				latitude: 39.99,
				phone: "13800138000",
			}).success,
		).toBe(false);
	});

	it("keeps source codes extensible while requiring an explicit coordinate system", () => {
		const base = {
			requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
			results: [
				{
					name: "测试地点",
					address: null,
					location: { latitude: 39.9, longitude: 116.4, crs: "GCJ02" },
					sourceLabel: "高德地图实时地点数据",
					providerRank: 1,
				},
			],
		};
		expect(
			LocationSearchResponseSchema.safeParse({
				...base,
				dataSource: "AMAP",
				dataMode: "LIVE",
			}).success,
		).toBe(true);
		expect(
			LocationSearchResponseSchema.safeParse({
				...base,
				dataSource: "LICENSED_VENDOR_2",
				dataMode: "LIVE",
			}).success,
		).toBe(true);
		expect(
			LocationSearchResponseSchema.safeParse({
				...base,
				dataSource: "amap",
				dataMode: "LIVE",
			}).success,
		).toBe(false);

		const parsed = LocationSearchResponseSchema.parse({
			...base,
			dataSource: "AMAP",
			dataMode: "LIVE",
			results: [{ ...base.results[0], providerPlaceId: "must-not-leak" }],
		});
		expect(parsed.results[0]).not.toHaveProperty("providerPlaceId");
	});
});

describe("Place keyword search contracts", () => {
	const validRequest = {
		location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
		mealPeriod: "LUNCH",
		keyword: "  牛肉面  ",
		radiusMeters: 1_500,
	};

	it("requires explicit coordinates and applies bounded defaults", () => {
		expect(PlaceSearchRequestSchema.parse(validRequest)).toEqual({
			...validRequest,
			keyword: "牛肉面",
			openNow: false,
			limit: 10,
		});
		expect(
			PlaceSearchRequestSchema.safeParse({
				...validRequest,
				location: { latitude: 39.9928, longitude: 116.3109 },
			}).success,
		).toBe(false);
	});

	it.each(["面", "粥"])(
		"accepts a single-character food keyword: %s",
		(keyword) => {
			expect(
				PlaceSearchRequestSchema.safeParse({ ...validRequest, keyword })
					.success,
			).toBe(true);
		},
	);

	it.each([
		"116.3109,39.9928",
		"坐标116.3109,39.9928附近",
		"牛肉面|火锅",
		"牛肉面｜火锅",
		"联系 13800138000",
		"test@example.com",
		"牛肉\u0000面",
	])("rejects sensitive or provider-control-shaped keywords: %s", (keyword) => {
		expect(
			PlaceSearchRequestSchema.safeParse({ ...validRequest, keyword }).success,
		).toBe(false);
	});

	it("bounds radius, filters, limit and undeclared identity fields", () => {
		for (const patch of [
			{ radiusMeters: 499 },
			{ radiusMeters: 5_001 },
			{ limit: 11 },
			{ maxAverageCostYuan: 0 },
			{ phone: "13800138000" },
		]) {
			expect(
				PlaceSearchRequestSchema.safeParse({ ...validRequest, ...patch })
					.success,
			).toBe(false);
		}
	});

	it("keeps the response provider-neutral and actions explicit", () => {
		const response = {
			requestId: VALID_UUID,
			coverage: "NATIONWIDE",
			results: [
				{
					resultToken: VALID_RESULT_TOKEN,
					rank: 2,
					name: "测试面馆",
					address: "测试地址",
					location: {
						latitude: 39.99,
						longitude: 116.31,
						crs: "GCJ02",
					},
					distanceMeters: 800,
					sourceLabel: "实时餐厅数据",
					sourceRating: 4.5,
					averageCostYuan: null,
					openStatus: "UNKNOWN",
					tags: ["面食"],
					dataMode: "LIVE",
					actions: {
						navigate: false,
						call: false,
						copyAddress: false,
						share: false,
					},
				},
			],
			notice: null,
		};
		expect(PlaceSearchResponseSchema.safeParse(response).success).toBe(true);
		expect(
			PlaceSearchResponseSchema.safeParse({
				...response,
				coverage: "REGIONAL",
			}).success,
		).toBe(false);
		expect(
			PlaceSearchResponseSchema.safeParse({
				...response,
				results: [
					{
						...response.results[0],
						provider: "AMAP",
						providerPlaceId: "private-poi-id",
					},
				],
			}).success,
		).toBe(false);
	});
});

describe("Account contracts", () => {
	const installationId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
	const challengeId = "3bf405ae-82a1-4f87-86b7-1c97c4a8683f";
	const state = "A".repeat(43);
	const device = {
		installationId,
		label: "Pixel 测试机",
		platform: "ANDROID",
		appVersion: "1.0.0-alpha.1",
	};

	it("allows account creation only through an ordinary phone challenge", () => {
		expect(
			PhoneRequestCodeSchema.safeParse({
				phoneNumber: "+8613800138000",
				purpose: "REGISTER",
				installationId,
			}).success,
		).toBe(true);
		expect(
			EmailRequestCodeSchema.safeParse({
				email: "user@example.com",
				purpose: "REGISTER",
				installationId,
			}).success,
		).toBe(false);
		expect(
			OAuthStateRequestSchema.safeParse({
				provider: "WECHAT",
				purpose: "REGISTER",
				installationId,
			}).success,
		).toBe(false);
	});

	it("accepts PHONE/WECHAT and already-bound EMAIL/QQ login shapes", () => {
		const requests = [
			{
				method: "PHONE",
				challengeId,
				otpCode: "123456",
				phoneNumber: "+8613800138000",
				device,
			},
			{ method: "EMAIL", challengeId, otpCode: "123456", device },
			{
				method: "WECHAT",
				oauthState: state,
				authorizationCode: "WechatCode123456",
				device,
			},
			{
				method: "QQ",
				oauthState: state,
				authorizationCode: "QqAuthorizationCode123456",
				device,
			},
		];
		for (const request of requests) {
			expect(LoginRequestSchema.safeParse(request).success).toBe(true);
		}
		expect(
			LoginRequestSchema.safeParse({
				method: "PHONE_FUSION",
				flowId: challengeId,
				verifyToken: "retired",
				device,
			}).success,
		).toBe(false);
		expect(
			LoginRequestSchema.safeParse({
				method: "PHONE",
				challengeId,
				otpCode: "123456",
				device,
			}).success,
		).toBe(false);
	});

	it("publishes capabilities without a retired Fusion switch", () => {
		const capabilities = {
			accountsEnabled: true,
			registrationEnabled: true,
			phoneEnabled: true,
			wechatEnabled: true,
			emailEnabled: false,
			qqEnabled: false,
			dataExportEnabled: false,
		};
		expect(AuthCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
		expect(
			AuthCapabilitiesSchema.safeParse({
				...capabilities,
				fusionEnabled: true,
			}).success,
		).toBe(false);
	});

	it("exposes only the Android 1.0 identity-purpose matrix", () => {
		for (const [purpose, allowed] of [
			["REGISTER", true],
			["LOGIN", true],
			["BIND", false],
			["RECOVERY", false],
		] as const) {
			expect(
				PhoneRequestCodeSchema.safeParse({
					phoneNumber: "+8613800138000",
					purpose,
					installationId,
				}).success,
			).toBe(allowed);
		}

		for (const [purpose, allowed] of [
			["REGISTER", false],
			["LOGIN", true],
			["BIND", true],
			["RECOVERY", false],
		] as const) {
			expect(
				EmailRequestCodeSchema.safeParse({
					email: "user@example.com",
					purpose,
					installationId,
				}).success,
			).toBe(allowed);
		}

		for (const [request, allowed] of [
			[{ provider: "WECHAT", purpose: "LOGIN", installationId }, true],
			[{ provider: "WECHAT", purpose: "BIND", installationId }, true],
			[{ provider: "WECHAT", purpose: "REGISTER", installationId }, false],
			[{ provider: "QQ", purpose: "REGISTER", installationId }, false],
			[{ provider: "QQ", purpose: "LOGIN", installationId }, true],
			[{ provider: "QQ", purpose: "BIND", installationId }, true],
		] as const) {
			expect(OAuthStateRequestSchema.safeParse(request).success).toBe(allowed);
		}

		for (const [request, allowed] of [
			[{ type: "PHONE", challengeId, otpCode: "123456" }, false],
			[{ type: "EMAIL", challengeId, otpCode: "123456" }, true],
			[
				{
					type: "WECHAT",
					oauthState: state,
					authorizationCode: "WechatCode123456",
				},
				true,
			],
			[
				{
					type: "QQ",
					oauthState: state,
					authorizationCode: "QqAuthorizationCode123456",
				},
				true,
			],
		] as const) {
			expect(BindIdentityRequestSchema.safeParse(request).success).toBe(
				allowed,
			);
		}
	});

	it("strictly rejects undeclared identity and credential fields", () => {
		expect(
			PhoneRequestCodeSchema.safeParse({
				phoneNumber: "+8613800138000",
				purpose: "LOGIN",
				installationId,
				email: "must-not-be-accepted@example.com",
			}).success,
		).toBe(false);
		expect(
			BindIdentityRequestSchema.safeParse({
				type: "EMAIL",
				challengeId,
				otpCode: "123456",
				phoneNumber: "+8613800138000",
			}).success,
		).toBe(false);
		expect(
			LoginRequestSchema.safeParse({
				method: "WECHAT",
				oauthState: state,
				authorizationCode: "WechatCode123456",
				device,
				appSecret: "must-never-cross-the-wire",
			}).success,
		).toBe(false);
		const qqLogin = {
			method: "QQ" as const,
			oauthState: state,
			authorizationCode: "QqAuthorizationCode123456",
			device,
		};
		for (const forbiddenField of [
			{ accessToken: "QqAccessToken1234567890" },
			{ openId: "client-must-not-assert-subject" },
			{ providerPayload: "must-not-cross-the-wire" },
		]) {
			expect(
				LoginRequestSchema.safeParse({
					...qqLogin,
					...forbiddenField,
				}).success,
			).toBe(false);
		}
		expect(
			LoginRequestSchema.safeParse({
				method: "QQ",
				oauthState: state,
				accessToken: "QqAccessToken1234567890",
				device,
			}).success,
		).toBe(false);

		const qqBinding = {
			type: "QQ" as const,
			oauthState: state,
			authorizationCode: "QqAuthorizationCode123456",
		};
		for (const forbiddenField of [
			{ accessToken: "QqAccessToken1234567890" },
			{ openId: "client-must-not-assert-subject" },
			{ providerPayload: "must-not-cross-the-wire" },
		]) {
			expect(
				BindIdentityRequestSchema.safeParse({
					...qqBinding,
					...forbiddenField,
				}).success,
			).toBe(false);
		}
		expect(
			BindIdentityRequestSchema.safeParse({
				type: "QQ",
				oauthState: state,
				accessToken: "QqAccessToken1234567890",
			}).success,
		).toBe(false);
	});

	it("constrains phone, OTP, OAuth state and App-owned tokens", () => {
		expect(
			PhoneRequestCodeSchema.safeParse({
				phoneNumber: "13800138000",
				purpose: "LOGIN",
				installationId,
			}).success,
		).toBe(false);
		expect(
			LoginRequestSchema.safeParse({
				method: "PHONE",
				challengeId,
				otpCode: "12345",
				phoneNumber: "+8613800138000",
				device,
			}).success,
		).toBe(false);
		expect(
			OAuthStateRequestSchema.safeParse({
				provider: "WECHAT",
				purpose: "LOGIN",
				installationId,
				extra: true,
			}).success,
		).toBe(false);
		expect(
			OAuthStateRequestSchema.safeParse({
				provider: "WECHAT",
				purpose: "LOGIN",
				installationId,
				phoneChallengeId: challengeId,
			}).success,
		).toBe(false);
		expect(
			OAuthStateRequestSchema.safeParse({
				provider: "WECHAT",
				purpose: "REGISTER",
				installationId,
			}).success,
		).toBe(false);
		expect(
			OAuthStateRequestSchema.safeParse({
				provider: "WECHAT",
				purpose: "LOGIN",
				installationId,
				phoneChallengeId: challengeId,
			}).success,
		).toBe(false);
		expect(
			OAuthStateRequestSchema.safeParse({
				provider: "QQ",
				purpose: "BIND",
				installationId,
			}).success,
		).toBe(true);
	});

	it("returns only internal IDs, masked identities and App-owned tokens", () => {
		const tokenResponse = AuthTokenResponseSchema.parse({
			userId: installationId,
			sessionId: challengeId,
			tokenType: "Bearer",
			accessToken: "A".repeat(43),
			accessTokenExpiresAt: "2026-08-20T12:15:00.000Z",
			refreshToken: "B".repeat(43),
			refreshTokenExpiresAt: "2026-09-19T12:00:00.000Z",
		});
		expect(JSON.stringify(tokenResponse)).not.toMatch(
			/appSecret|appKey|authorizationCode|openId|wechat|qq/i,
		);
		expect(
			AuthTokenResponseSchema.safeParse({
				...tokenResponse,
				providerAccessToken: "must-not-leak",
			}).success,
		).toBe(false);

		expect(
			IdentityBindingSchema.safeParse({
				bindingId: challengeId,
				type: "PHONE",
				maskedValue: "+86138****8000",
				boundAt: "2026-08-20T12:00:00.000Z",
				primary: true,
				canUnbind: false,
			}).success,
		).toBe(true);
		expect(
			IdentityBindingSchema.safeParse({
				bindingId: challengeId,
				type: "PHONE",
				maskedValue: "+8613800138000",
				boundAt: "2026-08-20T12:00:00.000Z",
				primary: true,
				canUnbind: false,
			}).success,
		).toBe(false);

		const exportResponse = AccountExportResponseSchema.parse({
			exportId: challengeId,
			status: "QUEUED",
			requestedAt: "2026-08-20T12:00:00.000Z",
			expiresAt: "2026-08-27T12:00:00.000Z",
			includeBehaviorHistory: false,
		});
		expect(exportResponse).not.toHaveProperty("downloadUrl");
		expect(exportResponse.includeBehaviorHistory).toBe(false);

		const ready = AccountExportStatusResponseSchema.parse({
			exportId: challengeId,
			status: "READY",
			requestedAt: "2026-08-20T12:00:00.000Z",
			readyAt: "2026-08-20T12:01:00.000Z",
			expiresAt: "2026-08-27T12:01:00.000Z",
			includeBehaviorHistory: true,
			sizeBytes: 1_024,
			sha256: "a".repeat(64),
			contentType: "application/json",
			downloadAvailable: true,
		});
		expect(ready.status).toBe("READY");
		expect(JSON.stringify(ready)).not.toMatch(
			/locator|objectKey|downloadUrl|token/iu,
		);
		expect(
			AccountExportStatusResponseSchema.safeParse({
				...ready,
				sizeBytes: 10_485_761,
			}).success,
		).toBe(false);
		expect(LatestAccountExportResponseSchema.parse({ item: null })).toEqual({
			item: null,
		});
	});
});
