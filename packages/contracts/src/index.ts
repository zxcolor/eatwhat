import { z } from "zod";
export * from "./canteen-decision.js";
export { CANTEEN_SERVER_CATALOG } from "./canteen-catalog.js";

// Public HTTP compatibility handshake. Clients may send the same header as a
// non-authoritative hint; the server always emits its own current value.
export const CONTRACT_VERSION_HEADER = "X-ChiShenMe-Contract-Version" as const;
export const CURRENT_CONTRACT_VERSION = "1" as const;

export const MealPeriodSchema = z.enum(["BREAKFAST", "LUNCH", "DINNER"]);
export type MealPeriod = z.infer<typeof MealPeriodSchema>;

export const RecommendationTargetSchema = z.enum([
	"MEAL",
	"MILK_TEA",
	"COFFEE",
	"DESSERT",
]);
export type RecommendationTarget = z.infer<typeof RecommendationTargetSchema>;

export const UserReportedWeatherPreferenceSchema = z.enum([
	"MINIMIZE_EXPOSURE",
	"WARMING",
	"COOLING",
]);
export type UserReportedWeatherPreference = z.infer<
	typeof UserReportedWeatherPreferenceSchema
>;

export const WeatherContextRequestSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("NONE") }).strict(),
	z
		.object({
			kind: z.literal("USER_REPORTED"),
			preference: UserReportedWeatherPreferenceSchema,
		})
		.strict(),
]);
export type WeatherContextRequest = z.infer<typeof WeatherContextRequestSchema>;

export const DecisionModeSchema = z.enum(["QUICK", "GUIDED"]);
export type DecisionMode = z.infer<typeof DecisionModeSchema>;

export const TravelModeSchema = z.enum(["WALK", "BIKE", "TRANSIT"]);
export type TravelMode = z.infer<typeof TravelModeSchema>;

export const ExplorationModeSchema = z.enum([
	"SAFE",
	"BALANCED",
	"ADVENTUROUS",
]);
export type ExplorationMode = z.infer<typeof ExplorationModeSchema>;

export const DataRightsModeSchema = z.enum([
	"LIVE_DISPLAY_ONLY",
	"LICENSED_ENRICHMENT",
]);
export type DataRightsMode = z.infer<typeof DataRightsModeSchema>;

// Provider identifiers are constrained data-source codes, not a closed enum.
// This lets an authorized adapter be added without changing the shared wire
// contract or teaching the recommendation engine vendor-specific values.
export const DataSourceCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/u);
export type DataSourceCode = z.infer<typeof DataSourceCodeSchema>;

export const DataModeSchema = z.enum(["LIVE", "DEMO"]);
export type DataMode = z.infer<typeof DataModeSchema>;

// Request-scoped, server-issued HMAC-SHA256 token encoded as unpadded base64url.
// It lets clients refer to a displayed result without learning a stable provider ID.
export const ResultTokenSchema = z
	.string()
	.length(43)
	.regex(/^[A-Za-z0-9_-]{43}$/u);
export type ResultToken = z.infer<typeof ResultTokenSchema>;

export const ConfidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const CuisinePreferenceSchema = z.enum([
	"中式快餐",
	"面食",
	"米饭",
	"火锅",
	"川湘菜",
	"清真",
	"素食",
	"西餐",
]);
export type CuisinePreference = z.infer<typeof CuisinePreferenceSchema>;

export const CoordinateReferenceSystemSchema = z.enum(["WGS84", "GCJ02"]);
export type CoordinateReferenceSystem = z.infer<
	typeof CoordinateReferenceSystemSchema
>;

export const CoordinateSchema = z.object({
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
	accuracyMeters: z.number().nonnegative().max(10_000).optional(),
	// Legacy clients only supplied Android/system coordinates, which are WGS84.
	// Keep that wire format safe while making every parsed coordinate explicit.
	crs: CoordinateReferenceSystemSchema.default("WGS84"),
});
export type Coordinate = z.infer<typeof CoordinateSchema>;

/**
 * User-controlled multipliers for the existing transparent suitability score.
 * A value of 100 keeps the established contribution unchanged; 0 ignores that
 * soft-score dimension. Hard filters are never affected by these preferences.
 */
export const DEFAULT_RECOMMENDATION_PREFERENCE_VECTOR = Object.freeze({
	quality: 100,
	time: 100,
	budget: 100,
	mealMatch: 100,
	diversity: 100,
});

export const RecommendationPreferenceVectorSchema = z
	.object({
		quality: z.number().int().min(0).max(100),
		time: z.number().int().min(0).max(100),
		budget: z.number().int().min(0).max(100),
		mealMatch: z.number().int().min(0).max(100),
		diversity: z.number().int().min(0).max(100),
	})
	.strict();
export type RecommendationPreferenceVector = z.infer<
	typeof RecommendationPreferenceVectorSchema
>;

export const RecommendationContextSchema = z.object({
	location: CoordinateSchema,
	locationLabel: z.string().trim().min(1).max(80).optional(),
	mealPeriod: MealPeriodSchema,
	target: RecommendationTargetSchema.default("MEAL"),
	weatherContext: WeatherContextRequestSchema.default(() => ({
		kind: "NONE" as const,
	})),
	decisionMode: DecisionModeSchema.default("QUICK"),
	travelMode: TravelModeSchema.default("WALK"),
	explorationMode: ExplorationModeSchema.default("BALANCED"),
	aiAssistanceEnabled: z.boolean().default(true),
	budgetMaxYuan: z
		.number()
		.int()
		.positive()
		.max(2_000)
		.nullable()
		.default(null),
	availableMinutes: z.number().int().min(15).max(240).default(60),
	radiusMeters: z.number().int().min(200).max(10_000),
	// Retained for v1 clients; recommendations are always for one person.
	partySize: z.literal(1).default(1),
	excludedCuisines: z.array(CuisinePreferenceSchema).max(20).default([]),
	preferredCuisines: z.array(CuisinePreferenceSchema).max(20).default([]),
	preferenceVector: RecommendationPreferenceVectorSchema.default(() => ({
		...DEFAULT_RECOMMENDATION_PREFERENCE_VECTOR,
	})),
	requestTime: z.iso.datetime().optional(),
});
export type RecommendationContext = z.infer<typeof RecommendationContextSchema>;

export const IntentProfileSchema = z.object({
	cuisineWeights: z.record(z.string(), z.number().min(0).max(1)),
	mealTypes: z.array(z.string()).min(1).max(8),
	speedPreference: z.enum(["FAST", "NORMAL", "RELAXED"]),
	diversityTarget: z.number().min(0).max(1),
	explanationSeed: z.string().trim().min(1).max(160),
	provider: z.enum(["QWEN", "RULE_FALLBACK"]),
});
export type IntentProfile = z.infer<typeof IntentProfileSchema>;

export const RecommendationReasonSchema = z.object({
	code: z.enum([
		"TIME_FIT",
		"BUDGET_FIT",
		"DISTANCE_FIT",
		"MEAL_FIT",
		"QUALITY_SIGNAL",
		"DIVERSITY",
	]),
	text: z.string().trim().min(1).max(120),
});
export type RecommendationReason = z.infer<typeof RecommendationReasonSchema>;

export const RecommendationActionsSchema = z
	.object({
		navigate: z.boolean(),
		call: z.boolean(),
		copyAddress: z.boolean(),
		share: z.boolean(),
	})
	.strict();
export type RecommendationActions = z.infer<typeof RecommendationActionsSchema>;

export const RecommendationResultSchema = z.object({
	provider: DataSourceCodeSchema,
	resultToken: ResultTokenSchema,
	dataMode: DataModeSchema,
	actions: RecommendationActionsSchema,
	name: z.string().min(1),
	address: z.string(),
	rank: z.number().int().positive(),
	fitScore: z.number().min(0).max(100).nullable(),
	sourceRating: z.number().min(0).max(5).nullable(),
	averageCostYuan: z.number().nonnegative().nullable(),
	distanceMeters: z.number().nonnegative(),
	estimatedTravelMinutes: z.number().nonnegative(),
	estimatedMealMinutes: z.number().positive(),
	openStatus: z.enum(["OPEN", "CLOSED", "UNKNOWN"]),
	tags: z.array(z.string()),
	imageUrl: z.url().nullable(),
	phone: z.string().nullable(),
	location: CoordinateSchema,
	reasons: z.array(RecommendationReasonSchema).min(1).max(4),
	warnings: z.array(z.string()),
	confidence: ConfidenceSchema,
	aiAssisted: z.boolean(),
	sourceAttribution: z.string(),
});
export type RecommendationResult = z.infer<typeof RecommendationResultSchema>;

export const RecommendationProfileFamilySchema = z.enum([
	"MEAL_LEGACY",
	"MEAL_BREAKFAST",
	"MEAL_LUNCH",
	"MEAL_DINNER",
	"MILK_TEA",
	"COFFEE",
	"DESSERT",
]);
export type RecommendationProfileFamily = z.infer<
	typeof RecommendationProfileFamilySchema
>;

const recommendationProfileVariant = <
	const Target extends RecommendationTarget,
	const Family extends RecommendationProfileFamily,
	const RequiresCapability extends boolean,
>(
	target: Target,
	family: Family,
	versionPrefix: string,
	providerCapabilityRequired: RequiresCapability,
) =>
	z
		.object({
			target: z.literal(target),
			family: z.literal(family),
			version: z
				.string()
				.max(80)
				.regex(new RegExp(`^${versionPrefix}-v[1-9]\\d*$`, "u")),
			providerCapabilityRequired: z.literal(providerCapabilityRequired),
		})
		.strict();

export const RecommendationProfileSchema = z.discriminatedUnion("family", [
	recommendationProfileVariant("MEAL", "MEAL_LEGACY", "meal-legacy", false),
	recommendationProfileVariant(
		"MEAL",
		"MEAL_BREAKFAST",
		"meal-breakfast",
		false,
	),
	recommendationProfileVariant("MEAL", "MEAL_LUNCH", "meal-lunch", false),
	recommendationProfileVariant("MEAL", "MEAL_DINNER", "meal-dinner", false),
	recommendationProfileVariant("MILK_TEA", "MILK_TEA", "milk-tea", true),
	recommendationProfileVariant("COFFEE", "COFFEE", "coffee", true),
	recommendationProfileVariant("DESSERT", "DESSERT", "dessert", true),
]);
export type RecommendationProfile = z.infer<typeof RecommendationProfileSchema>;

export const WeatherQueryModifierSchema = z.enum([
	"MINIMIZE_OUTDOOR_EXPOSURE",
	"PREFER_WARMING_OPTIONS",
	"PREFER_COOLING_OPTIONS",
]);
export type WeatherQueryModifier = z.infer<typeof WeatherQueryModifierSchema>;

const userReportedWeatherApplicationVariant = <
	const Preference extends UserReportedWeatherPreference,
	const Modifier extends WeatherQueryModifier,
>(
	preference: Preference,
	queryModifier: Modifier,
) =>
	z
		.object({
			kind: z.literal("USER_REPORTED"),
			version: z
				.string()
				.max(80)
				.regex(/^user-reported-weather-v[1-9]\d*$/u),
			preference: z.literal(preference),
			queryModifier: z.literal(queryModifier),
		})
		.strict();

export const WeatherApplicationSchema = z.union([
	z
		.object({
			kind: z.literal("NONE"),
			version: z
				.string()
				.max(80)
				.regex(/^weather-none-v[1-9]\d*$/u),
			queryModifier: z.null(),
		})
		.strict(),
	userReportedWeatherApplicationVariant(
		"MINIMIZE_EXPOSURE",
		"MINIMIZE_OUTDOOR_EXPOSURE",
	),
	userReportedWeatherApplicationVariant("WARMING", "PREFER_WARMING_OPTIONS"),
	userReportedWeatherApplicationVariant("COOLING", "PREFER_COOLING_OPTIONS"),
]);
export type WeatherApplication = z.infer<typeof WeatherApplicationSchema>;

export const DEFAULT_RECOMMENDATION_PROFILE = Object.freeze({
	target: "MEAL" as const,
	family: "MEAL_LEGACY" as const,
	version: "meal-legacy-v1" as const,
	providerCapabilityRequired: false as const,
});

export const DEFAULT_WEATHER_APPLICATION = Object.freeze({
	kind: "NONE" as const,
	version: "weather-none-v1" as const,
	queryModifier: null,
});

export const RecommendationResponseSchema = z.object({
	requestId: z.uuid(),
	generatedAt: z.iso.datetime(),
	coverage: z.literal("NATIONWIDE"),
	dataRightsMode: DataRightsModeSchema,
	ruleVersion: z.string(),
	rulesConfigVersion: z.number().int().positive().nullable().optional(),
	promptVersion: z.string(),
	modelVersion: z.string(),
	aiFallbackUsed: z.boolean(),
	profile: RecommendationProfileSchema.default(() => ({
		...DEFAULT_RECOMMENDATION_PROFILE,
	})),
	weatherApplication: WeatherApplicationSchema.default(() => ({
		...DEFAULT_WEATHER_APPLICATION,
	})),
	results: z.array(RecommendationResultSchema).max(3),
	notice: z.string().nullable(),
});
export type RecommendationResponse = z.infer<
	typeof RecommendationResponseSchema
>;

export const RecommendationEventSchema = z
	.object({
		requestId: z.uuid(),
		resultToken: ResultTokenSchema,
		type: z.enum([
			"IMPRESSION",
			"DETAIL",
			"FAVORITE",
			"NAVIGATION",
			"CALL",
			"REROLL",
		]),
		occurredAt: z.iso.datetime(),
	})
	.strict();
export type RecommendationEvent = z.infer<typeof RecommendationEventSchema>;

export const SupportFeedbackCategorySchema = z.enum([
	"PRODUCT",
	"PLACE_CORRECTION",
	"PRIVACY",
	"COMPLAINT",
]);
export type SupportFeedbackCategory = z.infer<
	typeof SupportFeedbackCategorySchema
>;

const SupportFeedbackMessageSchema = z
	.string()
	.transform((message) => message.replace(/\r\n?/gu, "\n").trim())
	.superRefine((message, context) => {
		const codePointLength = Array.from(message).length;
		if (codePointLength < 10 || codePointLength > 2_000) {
			context.addIssue({
				code: "custom",
				message: "反馈正文必须包含 10 到 2000 个 Unicode 字符",
			});
		}
		for (const character of message) {
			const codePoint = character.codePointAt(0) ?? 0;
			if (
				codePoint <= 0x08 ||
				(codePoint >= 0x0b && codePoint <= 0x1f) ||
				(codePoint >= 0x7f && codePoint <= 0x9f)
			) {
				context.addIssue({
					code: "custom",
					message: "反馈正文不得包含控制字符",
				});
				break;
			}
		}
	});

export const SupportFeedbackRequestSchema = z
	.object({
		submissionId: z
			.string()
			.regex(
				/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u,
			),
		category: SupportFeedbackCategorySchema,
		message: SupportFeedbackMessageSchema,
	})
	.strict();
export type SupportFeedbackRequest = z.infer<
	typeof SupportFeedbackRequestSchema
>;

export const SupportFeedbackResponseSchema = z
	.object({
		feedbackId: z.uuid(),
		accepted: z.literal(true),
		retentionAfterClosureDays: z.literal(180),
	})
	.strict();
export type SupportFeedbackResponse = z.infer<
	typeof SupportFeedbackResponseSchema
>;

export const IdempotencyKeySchema = z.uuid();
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const PageCursorSchema = z
	.string()
	.length(43)
	.regex(/^[A-Za-z0-9_-]{43}$/u);
export type PageCursor = z.infer<typeof PageCursorSchema>;

// Query strings arrive as strings. Accept only canonical decimal 1..50: no
// arrays, whitespace, leading zeroes, signs, decimals or scientific notation.
export const PageLimitSchema = z
	.string()
	.regex(/^(?:[1-9]|[1-4][0-9]|50)$/u)
	.default("20")
	.transform(Number);
export type PageLimit = z.infer<typeof PageLimitSchema>;

// A result token is accepted only as a short-lived creation proof. Durable
// operations address the current user's favoriteId/historyId/feedbackId and
// never expose the global external-place-reference primary key.
export const RecommendationResultReferenceInputSchema = z
	.object({
		requestId: z.uuid(),
		resultToken: ResultTokenSchema,
	})
	.strict();
export type RecommendationResultReferenceInput = z.infer<
	typeof RecommendationResultReferenceInputSchema
>;

export const FavoriteGroupSchema = z.enum(["WANT_TO_GO", "REGULAR"]);
export type FavoriteGroup = z.infer<typeof FavoriteGroupSchema>;

export const FavoriteMutationRequestSchema = z
	.object({
		idempotencyKey: IdempotencyKeySchema,
		result: RecommendationResultReferenceInputSchema,
		group: FavoriteGroupSchema,
	})
	.strict();
export type FavoriteMutationRequest = z.infer<
	typeof FavoriteMutationRequestSchema
>;

export const UpdateFavoriteGroupRequestSchema = z
	.object({
		idempotencyKey: IdempotencyKeySchema,
		group: FavoriteGroupSchema,
	})
	.strict();
export type UpdateFavoriteGroupRequest = z.infer<
	typeof UpdateFavoriteGroupRequestSchema
>;

export const PersistedPlacePresentationSchema = z.discriminatedUnion(
	"presentationStatus",
	[
		z
			.object({
				presentationStatus: z.literal("AVAILABLE"),
				name: z.string().trim().min(1).max(160),
				address: z.string().trim().max(240).nullable(),
				sourceLabel: z.string().trim().min(1).max(80),
				dataMode: z.literal("LIVE"),
				openStatus: z.enum(["OPEN", "CLOSED", "UNKNOWN"]),
				averageCostYuan: z.number().nonnegative().max(20_000).nullable(),
				tags: z.array(z.string().trim().min(1).max(40)).max(8),
				resolvedAt: z.iso.datetime(),
			})
			.strict(),
		z
			.object({
				presentationStatus: z.literal("TEMPORARILY_UNAVAILABLE"),
				retryable: z.literal(true),
			})
			.strict(),
		z
			.object({
				presentationStatus: z.literal("RIGHTS_REVOKED"),
				retryable: z.literal(false),
			})
			.strict(),
	],
);
export type PersistedPlacePresentation = z.infer<
	typeof PersistedPlacePresentationSchema
>;

export const FavoriteRecordSchema = z
	.object({
		favoriteId: z.uuid(),
		group: FavoriteGroupSchema,
		createdAt: z.iso.datetime(),
		presentation: PersistedPlacePresentationSchema,
	})
	.strict();
export type FavoriteRecord = z.infer<typeof FavoriteRecordSchema>;

export const ListFavoritesQuerySchema = z
	.object({
		cursor: PageCursorSchema.optional(),
		limit: PageLimitSchema,
		group: FavoriteGroupSchema.optional(),
	})
	.strict();
export type ListFavoritesQuery = z.infer<typeof ListFavoritesQuerySchema>;

export const FavoritesPageSchema = z
	.object({
		items: z.array(FavoriteRecordSchema).max(50),
		nextCursor: PageCursorSchema.nullable(),
	})
	.strict();
export type FavoritesPage = z.infer<typeof FavoritesPageSchema>;

// These names describe only an App action. In particular, opening navigation
// or the phone dialer is not evidence that the user arrived or ate there.
export const RecommendationHistoryActionSchema = z.enum([
	"RECOMMENDATION_SHOWN",
	"DETAIL_VIEWED",
	"FAVORITE_ADDED",
	"NAVIGATION_OPENED",
	"PHONE_DIALER_OPENED",
	"REROLL_REQUESTED",
]);
export type RecommendationHistoryAction = z.infer<
	typeof RecommendationHistoryActionSchema
>;

export const RECOMMENDATION_HISTORY_STORAGE_EVENT_BY_ACTION = {
	RECOMMENDATION_SHOWN: "IMPRESSION",
	DETAIL_VIEWED: "DETAIL",
	FAVORITE_ADDED: "FAVORITE",
	NAVIGATION_OPENED: "NAVIGATION",
	PHONE_DIALER_OPENED: "CALL",
	REROLL_REQUESTED: "REROLL",
} as const satisfies Readonly<Record<RecommendationHistoryAction, string>>;

const RECOMMENDATION_HISTORY_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000;

export const RecommendationHistoryItemSchema = z
	.object({
		historyId: z.uuid(),
		action: RecommendationHistoryActionSchema,
		mealPeriod: MealPeriodSchema,
		occurredAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
		presentation: PersistedPlacePresentationSchema.nullable(),
	})
	.strict()
	.superRefine((item, context) => {
		if (
			Date.parse(item.expiresAt) - Date.parse(item.occurredAt) !==
			RECOMMENDATION_HISTORY_RETENTION_MILLISECONDS
		) {
			context.addIssue({
				code: "custom",
				path: ["expiresAt"],
				message: "推荐历史必须在发生时间后 90 天到期",
			});
		}
	});
export type RecommendationHistoryItem = z.infer<
	typeof RecommendationHistoryItemSchema
>;

export const ListRecommendationHistoryQuerySchema = z
	.object({
		cursor: PageCursorSchema.optional(),
		limit: PageLimitSchema,
		action: RecommendationHistoryActionSchema.optional(),
	})
	.strict();
export type ListRecommendationHistoryQuery = z.infer<
	typeof ListRecommendationHistoryQuerySchema
>;

export const RecommendationHistoryPageSchema = z
	.object({
		items: z.array(RecommendationHistoryItemSchema).max(50),
		nextCursor: PageCursorSchema.nullable(),
		retentionDays: z.literal(90),
	})
	.strict();
export type RecommendationHistoryPage = z.infer<
	typeof RecommendationHistoryPageSchema
>;

export const PrivateFeedbackTypeSchema = z.enum([
	"WANT_TO_EAT",
	"ATE",
	"LIKE",
	"DISLIKE",
	"TOO_FAR",
	"TOO_EXPENSIVE",
	"RECENTLY_ATE",
	"AVOID_CUISINE",
]);
export type PrivateFeedbackType = z.infer<typeof PrivateFeedbackTypeSchema>;

// This explicit boundary is the only supported translation to the current DB
// vocabulary. Public names stay product-oriented while storage names remain a
// private implementation detail and cannot drift silently.
export const PrivateFeedbackStorageTypeSchema = z.enum([
	"WANT_TO_EAT",
	"ATE",
	"LIKE",
	"DISLIKE",
	"TOO_FAR",
	"TOO_EXPENSIVE",
	"ATE_RECENTLY",
	"EXCLUDE_CUISINE",
]);
export type PrivateFeedbackStorageType = z.infer<
	typeof PrivateFeedbackStorageTypeSchema
>;

export const PRIVATE_FEEDBACK_STORAGE_TYPE_BY_PUBLIC_TYPE = {
	WANT_TO_EAT: "WANT_TO_EAT",
	ATE: "ATE",
	LIKE: "LIKE",
	DISLIKE: "DISLIKE",
	TOO_FAR: "TOO_FAR",
	TOO_EXPENSIVE: "TOO_EXPENSIVE",
	RECENTLY_ATE: "ATE_RECENTLY",
	AVOID_CUISINE: "EXCLUDE_CUISINE",
} as const satisfies Readonly<
	Record<PrivateFeedbackType, PrivateFeedbackStorageType>
>;

export const CreatePrivateFeedbackRequestSchema = z
	.object({
		idempotencyKey: IdempotencyKeySchema,
		result: RecommendationResultReferenceInputSchema,
		type: PrivateFeedbackTypeSchema,
	})
	.strict();
export type CreatePrivateFeedbackRequest = z.infer<
	typeof CreatePrivateFeedbackRequestSchema
>;

export const PrivateFeedbackRecordSchema = z
	.object({
		feedbackId: z.uuid(),
		type: PrivateFeedbackTypeSchema,
		visibility: z.literal("PRIVATE"),
		createdAt: z.iso.datetime(),
		presentation: PersistedPlacePresentationSchema.nullable(),
	})
	.strict();
export type PrivateFeedbackRecord = z.infer<typeof PrivateFeedbackRecordSchema>;

export const ListPrivateFeedbackQuerySchema = z
	.object({
		cursor: PageCursorSchema.optional(),
		limit: PageLimitSchema,
		type: PrivateFeedbackTypeSchema.optional(),
	})
	.strict();
export type ListPrivateFeedbackQuery = z.infer<
	typeof ListPrivateFeedbackQuerySchema
>;

export const PrivateFeedbackPageSchema = z
	.object({
		items: z.array(PrivateFeedbackRecordSchema).max(50),
		nextCursor: PageCursorSchema.nullable(),
	})
	.strict();
export type PrivateFeedbackPage = z.infer<typeof PrivateFeedbackPageSchema>;

export const FavoriteIdPathSchema = z.object({ favoriteId: z.uuid() }).strict();
export type FavoriteIdPath = z.infer<typeof FavoriteIdPathSchema>;

export const FeedbackIdPathSchema = z.object({ feedbackId: z.uuid() }).strict();
export type FeedbackIdPath = z.infer<typeof FeedbackIdPathSchema>;

export const PersistenceCapabilitiesSchema = z
	.object({
		favoritesEnabled: z.boolean(),
		historyEnabled: z.boolean(),
		privateFeedbackEnabled: z.boolean(),
		savedResourceIdsEnabled: z.boolean(),
	})
	.strict();
export type PersistenceCapabilities = z.infer<
	typeof PersistenceCapabilitiesSchema
>;

// Account contracts deliberately use provider-neutral, App-owned identifiers.
// Third-party secrets and third-party access/refresh tokens are never response
// fields. Every account request is strict because silently stripping an
// identity, credential or purpose typo would be unsafe.
export const IdentityTypeSchema = z.enum(["PHONE", "WECHAT", "EMAIL", "QQ"]);
export type IdentityType = z.infer<typeof IdentityTypeSchema>;

export const OtpPurposeSchema = z.enum(["REGISTER", "LOGIN", "BIND"]);
export type OtpPurpose = z.infer<typeof OtpPurposeSchema>;

export const OAuthPurposeSchema = z.enum(["REGISTER", "LOGIN", "BIND"]);
export type OAuthPurpose = z.infer<typeof OAuthPurposeSchema>;

export const MainlandChinaPhoneSchema = z.string().regex(/^\+861[3-9]\d{9}$/u);
export type MainlandChinaPhone = z.infer<typeof MainlandChinaPhoneSchema>;

export const EmailAddressSchema = z.string().trim().min(3).max(254).email();
export type EmailAddress = z.infer<typeof EmailAddressSchema>;

export const OtpCodeSchema = z.string().regex(/^\d{6}$/u);
export type OtpCode = z.infer<typeof OtpCodeSchema>;

export const OAuthStateSchema = z
	.string()
	.length(43)
	.regex(/^[A-Za-z0-9_-]{43}$/u);
export type OAuthState = z.infer<typeof OAuthStateSchema>;

export const ThirdPartyAuthorizationCodeSchema = z
	.string()
	.min(8)
	.max(2_048)
	.regex(/^[A-Za-z0-9._~+/=-]+$/u);
export type ThirdPartyAuthorizationCode = z.infer<
	typeof ThirdPartyAuthorizationCodeSchema
>;

export const AppAccessTokenSchema = z
	.string()
	.length(43)
	.regex(/^[A-Za-z0-9_-]{43}$/u);
export type AppAccessToken = z.infer<typeof AppAccessTokenSchema>;

export const AppRefreshTokenSchema = z
	.string()
	.length(43)
	.regex(/^[A-Za-z0-9_-]{43}$/u);
export type AppRefreshToken = z.infer<typeof AppRefreshTokenSchema>;

export const AuthDeviceContextSchema = z
	.object({
		installationId: z.uuid(),
		label: z.string().trim().min(1).max(80),
		platform: z.enum(["ANDROID", "MINIPROGRAM"]),
		appVersion: z
			.string()
			.trim()
			.min(1)
			.max(32)
			.regex(/^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/u),
	})
	.strict();
export type AuthDeviceContext = z.infer<typeof AuthDeviceContextSchema>;

// The existing OAuth exchange belongs to native Android providers. A mini-program
// wx.login code needs a separate code2Session integration before it can be used.
const AndroidAuthDeviceContextSchema = AuthDeviceContextSchema.extend({
	platform: z.literal("ANDROID"),
});

export const PhoneRequestCodeSchema = z
	.object({
		phoneNumber: MainlandChinaPhoneSchema,
		purpose: z.enum(["REGISTER", "LOGIN"]),
		installationId: z.uuid(),
	})
	.strict();
export type PhoneRequestCode = z.infer<typeof PhoneRequestCodeSchema>;

// EMAIL cannot create an account. Keeping REGISTER out of this enum makes that
// product rule machine-checkable at the public boundary.
export const EmailRequestCodeSchema = z
	.object({
		email: EmailAddressSchema,
		purpose: z.enum(["LOGIN", "BIND"]),
		installationId: z.uuid(),
	})
	.strict();
export type EmailRequestCode = z.infer<typeof EmailRequestCodeSchema>;

export const PhoneCodeChallengeResponseSchema = z
	.object({
		challengeId: z.uuid(),
		targetType: z.literal("PHONE"),
		maskedTarget: z.string().regex(/^\+861\d{2}\*{4}\d{4}$/u),
		expiresAt: z.iso.datetime(),
		resendAvailableAt: z.iso.datetime(),
	})
	.strict();
export type PhoneCodeChallengeResponse = z.infer<
	typeof PhoneCodeChallengeResponseSchema
>;

export const EmailCodeChallengeResponseSchema = z
	.object({
		challengeId: z.uuid(),
		targetType: z.literal("EMAIL"),
		maskedTarget: z
			.string()
			.min(5)
			.max(254)
			.regex(/^[^@\s]*\*+[^@\s]*@[A-Za-z0-9.-]{1,190}$/u),
		expiresAt: z.iso.datetime(),
		resendAvailableAt: z.iso.datetime(),
	})
	.strict();
export type EmailCodeChallengeResponse = z.infer<
	typeof EmailCodeChallengeResponseSchema
>;

// Every state is bound to the App installation that will receive the native
// callback. Third-party identities can only log in when already bound or be
// bound from an authenticated session; they never create an account by
// themselves.
export const OAuthStateRequestSchema = z.union([
	z
		.object({
			provider: z.enum(["WECHAT", "QQ"]),
			purpose: z.literal("LOGIN"),
			installationId: z.uuid(),
		})
		.strict(),
	z
		.object({
			provider: z.enum(["WECHAT", "QQ"]),
			purpose: z.literal("BIND"),
			installationId: z.uuid(),
		})
		.strict(),
]);
export type OAuthStateRequest = z.infer<typeof OAuthStateRequestSchema>;

export const OAuthStateResponseSchema = z.discriminatedUnion("provider", [
	z
		.object({
			provider: z.literal("WECHAT"),
			purpose: z.enum(["LOGIN", "BIND"]),
			state: OAuthStateSchema,
			expiresAt: z.iso.datetime(),
		})
		.strict(),
	z
		.object({
			provider: z.literal("QQ"),
			purpose: z.enum(["LOGIN", "BIND"]),
			state: OAuthStateSchema,
			expiresAt: z.iso.datetime(),
		})
		.strict(),
]);
export type OAuthStateResponse = z.infer<typeof OAuthStateResponseSchema>;

const OtpLoginBaseSchema = z.object({
	challengeId: z.uuid(),
	otpCode: OtpCodeSchema,
	device: AuthDeviceContextSchema,
});

const ThirdPartyAuthorizationCredentialSchema = z.object({
	oauthState: OAuthStateSchema,
	authorizationCode: ThirdPartyAuthorizationCodeSchema,
});

export const LoginRequestSchema = z.discriminatedUnion("method", [
	OtpLoginBaseSchema.extend({
		method: z.literal("PHONE"),
		// PNVS needs the phone number at verification time. The service hashes it
		// again and requires an exact match with the challenge before calling the
		// provider, so a challenge cannot be replayed against another number.
		phoneNumber: MainlandChinaPhoneSchema,
	}).strict(),
	OtpLoginBaseSchema.extend({ method: z.literal("EMAIL") }).strict(),
	ThirdPartyAuthorizationCredentialSchema.extend({
		method: z.literal("WECHAT"),
		device: AndroidAuthDeviceContextSchema,
	}).strict(),
	ThirdPartyAuthorizationCredentialSchema.extend({
		method: z.literal("QQ"),
		device: AndroidAuthDeviceContextSchema,
	}).strict(),
]);
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

// A wx.login code is exchanged only by the server-owned mini-program channel.
// Callers cannot select an AppID, realm, UnionID or a target account.
export const WechatMiniProgramLoginRequestSchema = z
	.object({
		code: ThirdPartyAuthorizationCodeSchema,
		device: AuthDeviceContextSchema.extend({ platform: z.literal("MINIPROGRAM") }),
	})
	.strict();
export type WechatMiniProgramLoginRequest = z.infer<
	typeof WechatMiniProgramLoginRequestSchema
>;

export const AuthTokenResponseSchema = z
	.object({
		userId: z.uuid(),
		sessionId: z.uuid(),
		tokenType: z.literal("Bearer"),
		accessToken: AppAccessTokenSchema,
		accessTokenExpiresAt: z.iso.datetime(),
		refreshToken: AppRefreshTokenSchema,
		refreshTokenExpiresAt: z.iso.datetime(),
	})
	.strict();
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;

export const RefreshRequestSchema = z
	.object({
		refreshToken: AppRefreshTokenSchema,
		installationId: z.uuid(),
	})
	.strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z.object({}).strict();
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const LogoutResponseSchema = z
	.object({
		sessionId: z.uuid(),
		loggedOutAt: z.iso.datetime(),
	})
	.strict();
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

const PhoneIdentityBindingSchema = z
	.object({
		bindingId: z.uuid(),
		type: z.literal("PHONE"),
		maskedValue: z.string().regex(/^\+861\d{2}\*{4}\d{4}$/u),
		boundAt: z.iso.datetime(),
		primary: z.boolean(),
		canUnbind: z.boolean(),
	})
	.strict();

const EmailIdentityBindingSchema = z
	.object({
		bindingId: z.uuid(),
		type: z.literal("EMAIL"),
		maskedValue: z
			.string()
			.min(5)
			.max(254)
			.regex(/^[^@\s]*\*+[^@\s]*@[A-Za-z0-9.-]{1,190}$/u),
		boundAt: z.iso.datetime(),
		primary: z.boolean(),
		canUnbind: z.boolean(),
	})
	.strict();

const WechatIdentityBindingSchema = z
	.object({
		bindingId: z.uuid(),
		type: z.literal("WECHAT"),
		maskedValue: z.literal("微信账号"),
		boundAt: z.iso.datetime(),
		primary: z.boolean(),
		canUnbind: z.boolean(),
	})
	.strict();

const QqIdentityBindingSchema = z
	.object({
		bindingId: z.uuid(),
		type: z.literal("QQ"),
		maskedValue: z.literal("QQ 账号"),
		boundAt: z.iso.datetime(),
		primary: z.boolean(),
		canUnbind: z.boolean(),
	})
	.strict();

export const IdentityBindingSchema = z.discriminatedUnion("type", [
	PhoneIdentityBindingSchema,
	WechatIdentityBindingSchema,
	EmailIdentityBindingSchema,
	QqIdentityBindingSchema,
]);
export type IdentityBinding = z.infer<typeof IdentityBindingSchema>;

export const IdentityBindingsResponseSchema = z
	.object({
		items: z.array(IdentityBindingSchema).max(8),
	})
	.strict();
export type IdentityBindingsResponse = z.infer<
	typeof IdentityBindingsResponseSchema
>;

export const BindIdentityRequestSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("EMAIL"),
			challengeId: z.uuid(),
			otpCode: OtpCodeSchema,
		})
		.strict(),
	ThirdPartyAuthorizationCredentialSchema.extend({
		type: z.literal("WECHAT"),
	}).strict(),
	ThirdPartyAuthorizationCredentialSchema.extend({
		type: z.literal("QQ"),
	}).strict(),
]);
export type BindIdentityRequest = z.infer<typeof BindIdentityRequestSchema>;

export const BindIdentityResponseSchema = z
	.object({
		binding: IdentityBindingSchema,
	})
	.strict();
export type BindIdentityResponse = z.infer<typeof BindIdentityResponseSchema>;

export const BindingIdPathSchema = z.object({ bindingId: z.uuid() }).strict();
export type BindingIdPath = z.infer<typeof BindingIdPathSchema>;

export const UnbindIdentityResponseSchema = z
	.object({
		bindingId: z.uuid(),
		unboundAt: z.iso.datetime(),
	})
	.strict();
export type UnbindIdentityResponse = z.infer<
	typeof UnbindIdentityResponseSchema
>;

export const SessionSummarySchema = z
	.object({
		sessionId: z.uuid(),
		deviceLabel: z.string().trim().min(1).max(80),
		platform: z.enum(["ANDROID", "MINIPROGRAM"]),
		current: z.boolean(),
		createdAt: z.iso.datetime(),
		lastActiveAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
	})
	.strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** New clients opt in; absent preserves Android-only v1 clients. */
export const ListSessionsQuerySchema = z.object({ includePlatforms: z.literal("ALL").optional() }).strict();
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

export const SessionsResponseSchema = z
	.object({ items: z.array(SessionSummarySchema).max(50) })
	.strict();
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;

export const SessionIdPathSchema = z.object({ sessionId: z.uuid() }).strict();
export type SessionIdPath = z.infer<typeof SessionIdPathSchema>;

export const RevokeSessionResponseSchema = z
	.object({
		sessionId: z.uuid(),
		revokedAt: z.iso.datetime(),
	})
	.strict();
export type RevokeSessionResponse = z.infer<typeof RevokeSessionResponseSchema>;

export const AccountExportRequestSchema = z
	.object({
		format: z.literal("JSON").default("JSON"),
		includeBehaviorHistory: z.boolean().default(true),
	})
	.strict();
export type AccountExportRequest = z.infer<typeof AccountExportRequestSchema>;

export const AccountExportResponseSchema = z
	.object({
		exportId: z.uuid(),
		status: z.literal("QUEUED"),
		requestedAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
		includeBehaviorHistory: z.boolean(),
	})
	.strict();
export type AccountExportResponse = z.infer<typeof AccountExportResponseSchema>;

export const AccountExportIdPathSchema = z
	.object({ exportId: z.uuid() })
	.strict();
export type AccountExportIdPath = z.infer<typeof AccountExportIdPathSchema>;

const AccountExportStatusBaseSchema = z.object({
	exportId: z.uuid(),
	requestedAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	includeBehaviorHistory: z.boolean(),
});

const AccountExportPendingStatusSchema = AccountExportStatusBaseSchema.extend({
	status: z.enum(["QUEUED", "PROCESSING"]),
	downloadAvailable: z.literal(false),
}).strict();

const AccountExportReadyStatusSchema = AccountExportStatusBaseSchema.extend({
	status: z.literal("READY"),
	readyAt: z.iso.datetime(),
	sizeBytes: z.number().int().nonnegative().max(10_485_760),
	sha256: z.string().regex(/^[0-9a-f]{64}$/u),
	contentType: z.literal("application/json"),
	downloadAvailable: z.literal(true),
}).strict();

const AccountExportFailedStatusSchema = AccountExportStatusBaseSchema.extend({
	status: z.literal("FAILED"),
	failureCode: z.literal("GENERATION_FAILED"),
	downloadAvailable: z.literal(false),
}).strict();

const AccountExportExpiredStatusSchema = AccountExportStatusBaseSchema.extend({
	status: z.literal("EXPIRED"),
	downloadAvailable: z.literal(false),
}).strict();

export const AccountExportStatusResponseSchema = z.discriminatedUnion(
	"status",
	[
		AccountExportPendingStatusSchema,
		AccountExportReadyStatusSchema,
		AccountExportFailedStatusSchema,
		AccountExportExpiredStatusSchema,
	],
);
export type AccountExportStatusResponse = z.infer<
	typeof AccountExportStatusResponseSchema
>;

export const LatestAccountExportResponseSchema = z
	.object({ item: AccountExportStatusResponseSchema.nullable() })
	.strict();
export type LatestAccountExportResponse = z.infer<
	typeof LatestAccountExportResponseSchema
>;

export const DeleteAccountRequestSchema = z
	.object({ confirmation: z.literal("DELETE_MY_ACCOUNT") })
	.strict();
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

export const DeleteAccountResponseSchema = z
	.object({
		deletionId: z.uuid(),
		userId: z.uuid(),
		status: z.literal("DEACTIVATED"),
		invalidatedAt: z.iso.datetime(),
		backupDeletionDeadline: z.iso.datetime(),
	})
	.strict();
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;

export const AuthCapabilitiesSchema = z
	.object({
		accountsEnabled: z.boolean(),
		registrationEnabled: z.boolean(),
		phoneEnabled: z.boolean(),
		wechatEnabled: z.boolean(),
		wechatMiniProgramEnabled: z.boolean().optional(),
		emailEnabled: z.boolean(),
		qqEnabled: z.boolean(),
		dataExportEnabled: z.boolean().default(false),
	})
	.strict();
export type AuthCapabilities = z.infer<typeof AuthCapabilitiesSchema>;

export const ServiceCapabilitiesSchema = z
	.object({
		recommendationsEnabled: z.boolean().default(false),
		// Compatibility signal for older clients. Group dining is retired.
		groupRecommendationsEnabled: z.literal(false).default(false),
		locationSearchEnabled: z.boolean().default(false),
		placeSearchEnabled: z.boolean().default(false),
	})
	.strict();
export type ServiceCapabilities = z.infer<typeof ServiceCapabilitiesSchema>;

export const DISABLED_SERVICE_CAPABILITIES: Readonly<ServiceCapabilities> =
	Object.freeze({
		recommendationsEnabled: false,
		groupRecommendationsEnabled: false,
		locationSearchEnabled: false,
		placeSearchEnabled: false,
	});

export const SpecialtyCapabilitiesSchema = z
	.object({
		breakfastProfileEnabled: z.boolean(),
		dinnerProfileEnabled: z.boolean(),
		milkTeaEnabled: z.boolean(),
		coffeeEnabled: z.boolean(),
		dessertEnabled: z.boolean(),
		userReportedWeatherEnabled: z.boolean(),
	})
	.strict();
export type SpecialtyCapabilities = z.infer<typeof SpecialtyCapabilitiesSchema>;

export const DISABLED_SPECIALTY_CAPABILITIES: Readonly<SpecialtyCapabilities> =
	Object.freeze({
		breakfastProfileEnabled: false,
		dinnerProfileEnabled: false,
		milkTeaEnabled: false,
		coffeeEnabled: false,
		dessertEnabled: false,
		userReportedWeatherEnabled: false,
	});

const PublicSemanticVersionSchema = z
	.string()
	.regex(
		/^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/u,
	);

export const PublicRecommendationDefaultsSchema = z
	.object({
		areaCode: z.literal("NATIONWIDE"),
		defaultRadiusMeters: z.number().int().min(200).max(10_000),
		maximumRadiusMeters: z.number().int().min(200).max(10_000),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.defaultRadiusMeters > value.maximumRadiusMeters) {
			context.addIssue({
				code: "custom",
				path: ["defaultRadiusMeters"],
				message: "默认半径不能大于最大半径",
			});
		}
	});
export type PublicRecommendationDefaults = z.infer<
	typeof PublicRecommendationDefaultsSchema
>;

export const PublicMinimumSupportedVersionsSchema = z
	.object({
		android: PublicSemanticVersionSchema,
		ios: PublicSemanticVersionSchema.optional(),
		miniprogram: PublicSemanticVersionSchema.optional(),
	})
	.strict();
export type PublicMinimumSupportedVersions = z.infer<
	typeof PublicMinimumSupportedVersionsSchema
>;

export const PublicOperationalConfigSchema = z
	.object({
		source: z.enum([
			"STARTUP_DEFAULT",
			"DATABASE",
			"STALE_CACHE",
			"SAFE_FALLBACK",
		]),
		lastSuccessfulReadAt: z.iso.datetime().nullable(),
		cacheTtlMs: z.literal(5_000),
		versions: z
			.object({
				"features.ai-assistance": z.number().int().positive().nullable(),
				"recommendations.rules": z.number().int().positive().nullable(),
				"recommendations.prompt": z.number().int().positive().nullable(),
				"coverage.default": z.number().int().positive().nullable(),
				"clients.minimum-version": z.number().int().positive().nullable(),
			})
			.strict(),
		aiStatus: z.enum([
			"ENABLED",
			"SERVER_DISABLED",
			"OPERATOR_DISABLED",
			"PROMPT_DISABLED",
			"CONFIG_UNAVAILABLE",
		]),
	})
	.strict();
export type PublicOperationalConfig = z.infer<
	typeof PublicOperationalConfigSchema
>;

export const FeatureConfigSchema = z
	.object({
		nearbyRestaurantCollectionEnabled: z.boolean().optional(),
		coverageName: z.string(),
		dataRightsMode: DataRightsModeSchema,
		aiEnabled: z.boolean(),
		accountsEnabled: z.boolean(),
		favoritesEnabled: z.boolean(),
		// Older v1 config responses did not include this capability. Parsing such
		// responses must fail closed while current services always emit the field.
		supportFeedbackEnabled: z.boolean().default(false),
		minimumSupportedVersion: PublicSemanticVersionSchema,
		// Optional for older v1 response compatibility. Current services emit both
		// projections so Android, iOS and mini-program clients can share one source.
		recommendationDefaults: PublicRecommendationDefaultsSchema.optional(),
		minimumSupportedVersions: PublicMinimumSupportedVersionsSchema.optional(),
		operationalConfig: PublicOperationalConfigSchema.optional(),
		ruleVersion: z.string(),
		rulesConfigVersion: z.number().int().positive().nullable().optional(),
		promptVersion: z.string(),
		modelVersion: z.string(),
		// Absent means every persistence capability is disabled for older v1
		// clients/services. LIVE_DISPLAY_ONLY must expose every field as false.
		persistenceCapabilities: PersistenceCapabilitiesSchema.optional(),
		// Optional is backward compatible with already deployed v1 config responses.
		authCapabilities: AuthCapabilitiesSchema.optional(),
		// Older v1 services did not advertise provider readiness. Missing or partial
		// capability metadata must therefore close every remote data path.
		serviceCapabilities: ServiceCapabilitiesSchema.default(
			DISABLED_SERVICE_CAPABILITIES,
		),
		// Older v1 services did not advertise specialty query-plan support. The
		// whole object may therefore be absent, but a present object is atomic:
		// consumers must never infer omitted fields as enabled capabilities.
		specialtyCapabilities: SpecialtyCapabilitiesSchema.optional(),
	})
	.strict()
	.superRefine((config, context) => {
		if (
			config.minimumSupportedVersions !== undefined &&
			config.minimumSupportedVersions.android !== config.minimumSupportedVersion
		) {
			context.addIssue({
				code: "custom",
				path: ["minimumSupportedVersions", "android"],
				message: "Android 最低版本必须与兼容字段一致",
			});
		}
		const capabilities = config.persistenceCapabilities;
		if (
			capabilities !== undefined &&
			capabilities.favoritesEnabled !== config.favoritesEnabled
		) {
			context.addIssue({
				code: "custom",
				path: ["persistenceCapabilities", "favoritesEnabled"],
				message: "收藏能力必须与兼容字段 favoritesEnabled 一致",
			});
		}
		if (
			config.dataRightsMode === "LIVE_DISPLAY_ONLY" &&
			(config.favoritesEnabled ||
				(capabilities !== undefined &&
					Object.values(capabilities).some(Boolean)))
		) {
			context.addIssue({
				code: "custom",
				path: ["persistenceCapabilities"],
				message: "实时展示模式不得开放餐厅引用持久化能力",
			});
		}
	});
export type FeatureConfig = z.infer<typeof FeatureConfigSchema>;

const OBVIOUS_COORDINATE_PATTERN =
	/(?:^|\s)[+-]?(?:\d{1,3}(?:\.\d+)?)\s*[,，]\s*[+-]?(?:\d{1,3}(?:\.\d+)?)(?:\s|$)/u;
const OBVIOUS_PHONE_PATTERN =
	/(?:^|\D)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?:\D|$)/u;
const OBVIOUS_EMAIL_PATTERN =
	/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u;
const EMBEDDED_COORDINATE_PATTERN =
	/(?:^|[^\d])[+-]?(?:\d{1,3}(?:\.\d+)?)\s*[,，]\s*[+-]?(?:\d{1,3}(?:\.\d+)?)(?=$|[^\d])/u;

function containsControlOrPipe(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return (
			character === "|" ||
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f)
		);
	});
}

export const LocationSearchRequestSchema = z
	.object({
		query: z.string().trim().min(2).max(80),
	})
	.strict()
	.superRefine((request, context) => {
		const unsafe =
			containsControlOrPipe(request.query) ||
			OBVIOUS_COORDINATE_PATTERN.test(request.query) ||
			OBVIOUS_PHONE_PATTERN.test(request.query) ||
			OBVIOUS_EMAIL_PATTERN.test(request.query);
		if (unsafe) {
			context.addIssue({
				code: "custom",
				path: ["query"],
				message: "请输入地点名称，不要输入坐标、手机号、邮箱或分隔符",
			});
		}
	});
export type LocationSearchRequest = z.infer<typeof LocationSearchRequestSchema>;

export const LocationSearchResultSchema = z.object({
	name: z.string().trim().min(1).max(120),
	address: z.string().trim().max(200).nullable(),
	location: CoordinateSchema,
	sourceLabel: z.string().trim().min(1).max(80),
	providerRank: z.number().int().min(1).max(5),
});
export type LocationSearchResult = z.infer<typeof LocationSearchResultSchema>;

export const LocationSearchResponseSchema = z.object({
	requestId: z.uuid(),
	// This is intentionally a constrained provider code instead of an enum so a
	// newly licensed adapter can be deployed without changing client contracts.
	dataSource: DataSourceCodeSchema,
	dataMode: DataModeSchema,
	results: z.array(LocationSearchResultSchema).max(5),
});
export type LocationSearchResponse = z.infer<
	typeof LocationSearchResponseSchema
>;

// Nearby restaurant keyword search is deliberately separate from location
// lookup and recommendation. Coordinates are required and explicit on both
// input and output; the keyword is the only free-form search field.
export const PlaceSearchCoordinateSchema = z
	.object({
		latitude: z.number().min(-90).max(90),
		longitude: z.number().min(-180).max(180),
		crs: CoordinateReferenceSystemSchema,
	})
	.strict();
export type PlaceSearchCoordinate = z.infer<typeof PlaceSearchCoordinateSchema>;

// City-only presentation lookup. Origin coordinates remain transient JSON body
// data; no detailed address, supplier identifiers or coordinates are returned.
export const LocationCityRequestSchema = z.object({
	location: PlaceSearchCoordinateSchema,
}).strict();
export type LocationCityRequest = z.infer<typeof LocationCityRequestSchema>;
export const LocationCityResponseSchema = z.object({
	city: z.string().trim().min(1).max(80).nullable(),
}).strict();
export type LocationCityResponse = z.infer<typeof LocationCityResponseSchema>;

export const PlaceSearchRequestSchema = z
	.object({
		location: PlaceSearchCoordinateSchema,
		mealPeriod: MealPeriodSchema,
		keyword: z.string().trim().min(1).max(80),
		radiusMeters: z.number().int().min(500).max(5_000),
		maxAverageCostYuan: z.number().int().positive().max(20_000).optional(),
		openNow: z.boolean().default(false),
		limit: z.number().int().min(1).max(10).default(10),
	})
	.strict()
	.superRefine((request, context) => {
		const unsafe =
			containsControlOrPipe(request.keyword) ||
			request.keyword.includes("｜") ||
			EMBEDDED_COORDINATE_PATTERN.test(request.keyword) ||
			OBVIOUS_PHONE_PATTERN.test(request.keyword) ||
			OBVIOUS_EMAIL_PATTERN.test(request.keyword);
		if (unsafe) {
			context.addIssue({
				code: "custom",
				path: ["keyword"],
				message:
					"请输入餐厅、菜系或食物关键词，不要输入坐标、手机号、邮箱或分隔符",
			});
		}
	});
export type PlaceSearchRequest = z.infer<typeof PlaceSearchRequestSchema>;

export const PlaceSearchResultSchema = z
	.object({
		resultToken: ResultTokenSchema,
		rank: z.number().int().min(1).max(25),
		name: z.string().trim().min(1).max(160),
		address: z.string().trim().max(240).nullable(),
		location: PlaceSearchCoordinateSchema,
		distanceMeters: z.number().int().nonnegative().max(100_000),
		sourceLabel: z.string().trim().min(1).max(80),
		sourceRating: z.number().min(0).max(5).nullable(),
		averageCostYuan: z.number().nonnegative().max(20_000).nullable(),
		openStatus: z.enum(["OPEN", "CLOSED", "UNKNOWN"]),
		tags: z.array(z.string().trim().min(1).max(80)).max(20),
		dataMode: DataModeSchema,
		actions: RecommendationActionsSchema,
	})
	.strict();
export type PlaceSearchResult = z.infer<typeof PlaceSearchResultSchema>;

export const PlaceSearchResponseSchema = z
	.object({
		requestId: z.uuid(),
		coverage: z.literal("NATIONWIDE"),
		results: z.array(PlaceSearchResultSchema).max(10),
		notice: z.string().trim().min(1).max(160).nullable(),
	})
	.strict();
export type PlaceSearchResponse = z.infer<typeof PlaceSearchResponseSchema>;

// Authorized device-local collection is separate from ranking and account
// persistence. The user's origin remains transient request data only.
export const NearbyRestaurantRequestSchema = z.object({
	location: PlaceSearchCoordinateSchema,
	page: z.number().int().min(1).max(2).default(1),
}).strict();
export type NearbyRestaurantRequest = z.infer<typeof NearbyRestaurantRequestSchema>;
export const NearbyRestaurantSchema = z.object({
	provider: DataSourceCodeSchema,
	providerPlaceId: z.string().trim().min(1).max(160),
	name: z.string().trim().min(1).max(160),
	address: z.string().max(240),
	location: PlaceSearchCoordinateSchema,
	sourceRating: z.number().min(0).max(5).nullable(),
	averageCostYuan: z.number().nonnegative().max(20_000).nullable(),
	openStatus: z.enum(["OPEN", "CLOSED", "UNKNOWN"]),
	tags: z.array(z.string().min(1).max(80)).max(20),
	phone: z.string().max(160).nullable(),
	sourceAttribution: z.string().min(1).max(80),
	dataMode: DataModeSchema,
}).strict();
export type NearbyRestaurant = z.infer<typeof NearbyRestaurantSchema>;
export const NearbyRestaurantResponseSchema = z.object({
	radiusMeters: z.literal(3500),
	retentionDays: z.literal(90),
	page: z.number().int().min(1).max(2),
	nextPage: z.literal(2).nullable(),
	truncated: z.boolean(),
	restaurants: z.array(NearbyRestaurantSchema).max(25),
}).strict();
export type NearbyRestaurantResponse = z.infer<typeof NearbyRestaurantResponseSchema>;

// Administrator HTTP contracts are deliberately separated from the public
// account contract. An administrator bearer can only be resolved against the
// isolated admin database role and is never accepted by ordinary /v1 routes.
export const ADMIN_CONTRACT_VERSION_HEADER =
	"X-ChiShenMe-Admin-Contract-Version" as const;
export const CURRENT_ADMIN_CONTRACT_VERSION = "1" as const;
export const ADMIN_DEVICE_ID_HEADER = "X-Admin-Device-Id" as const;

export const AdminOpaqueTokenSchema = z
	.string()
	.length(43)
	.regex(/^[A-Za-z0-9_-]{43}$/u);
export type AdminOpaqueToken = z.infer<typeof AdminOpaqueTokenSchema>;

export const AdminDeviceIdSchema = AdminOpaqueTokenSchema;
export type AdminDeviceId = z.infer<typeof AdminDeviceIdSchema>;

export const AdminCredentialHandleSchema = AdminOpaqueTokenSchema;
export type AdminCredentialHandle = z.infer<typeof AdminCredentialHandleSchema>;

export const AdminPermissionCodeSchema = z.enum([
	"AUDIT_READ",
	"OPERATIONS_READ",
	"FEEDBACK_MANAGE",
	"PLACE_DATA_MANAGE",
	"ALGORITHM_CONFIG_READ",
	"ALGORITHM_CONFIG_WRITE",
	"SECURITY_ADMIN_READ",
	"SECURITY_ADMIN_WRITE",
	"CREDENTIAL_SELF_MANAGE",
]);
export type AdminPermissionCode = z.infer<typeof AdminPermissionCodeSchema>;

const AdminWebAuthnBase64UrlSchema = z
	.string()
	.min(1)
	.max(90_000)
	.regex(/^[A-Za-z0-9_-]+$/u);
const AdminWebAuthnCredentialIdSchema = AdminWebAuthnBase64UrlSchema.max(2_048);
const AdminWebAuthnChallengeSchema =
	AdminWebAuthnBase64UrlSchema.min(32).max(128);

export const AdminAuthenticatorTransportSchema = z.enum([
	"ble",
	"cable",
	"hybrid",
	"internal",
	"nfc",
	"smart-card",
	"usb",
]);
export type AdminAuthenticatorTransport = z.infer<
	typeof AdminAuthenticatorTransportSchema
>;

export const AdminLoginOptionsRequestSchema = z
	.object({
		login: z
			.string()
			.trim()
			.min(3)
			.max(128)
			.regex(/^[\p{L}\p{N}._@+-]+$/u),
	})
	.strict();
export type AdminLoginOptionsRequest = z.infer<
	typeof AdminLoginOptionsRequestSchema
>;

export const AdminAuthenticationOptionsSchema = z
	.object({
		challenge: AdminWebAuthnChallengeSchema,
		timeout: z.number().int().min(1_000).max(300_000),
		rpId: z.string().min(1).max(253),
		allowCredentials: z
			.array(
				z
					.object({
						id: AdminWebAuthnCredentialIdSchema,
						type: z.literal("public-key"),
						transports: z
							.array(AdminAuthenticatorTransportSchema)
							.max(7)
							.optional(),
					})
					.strict(),
			)
			.length(0),
		userVerification: z.literal("required"),
	})
	.strict();
export type AdminAuthenticationOptions = z.infer<
	typeof AdminAuthenticationOptionsSchema
>;

export const AdminLoginOptionsResponseSchema = z
	.object({
		ceremonyId: z.uuid(),
		expiresAt: z.iso.datetime(),
		publicKey: AdminAuthenticationOptionsSchema,
	})
	.strict();
export type AdminLoginOptionsResponse = z.infer<
	typeof AdminLoginOptionsResponseSchema
>;

const AdminClientExtensionResultsSchema = z.record(
	z.string().min(1).max(100),
	z.unknown(),
);

export const AdminAuthenticationResponseJSONSchema = z
	.object({
		id: AdminWebAuthnCredentialIdSchema,
		rawId: AdminWebAuthnCredentialIdSchema,
		response: z
			.object({
				clientDataJSON: AdminWebAuthnBase64UrlSchema.max(8_192),
				authenticatorData: AdminWebAuthnBase64UrlSchema.max(16_384),
				signature: AdminWebAuthnBase64UrlSchema.max(16_384),
				userHandle: AdminWebAuthnBase64UrlSchema.max(2_048).nullable(),
			})
			.strict(),
		type: z.literal("public-key"),
		clientExtensionResults: AdminClientExtensionResultsSchema,
		authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
	})
	.strict()
	.superRefine((response, context) => {
		if (response.id !== response.rawId) {
			context.addIssue({
				code: "custom",
				path: ["rawId"],
				message: "WebAuthn credential id 与 rawId 必须一致",
			});
		}
	});
export type AdminAuthenticationResponseJSON = z.infer<
	typeof AdminAuthenticationResponseJSONSchema
>;

export const AdminLoginVerifyRequestSchema = z
	.object({
		ceremonyId: z.uuid(),
		response: AdminAuthenticationResponseJSONSchema,
	})
	.strict();
export type AdminLoginVerifyRequest = z.infer<
	typeof AdminLoginVerifyRequestSchema
>;

export const AdminLoginVerifyResponseSchema = z
	.object({
		adminToken: AdminOpaqueTokenSchema,
		tokenType: z.literal("Bearer"),
		absoluteExpiresAt: z.iso.datetime(),
		idleTimeoutSeconds: z.literal(900),
		permissions: z.array(AdminPermissionCodeSchema).max(9),
	})
	.strict();
export type AdminLoginVerifyResponse = z.infer<
	typeof AdminLoginVerifyResponseSchema
>;

export const AdminCurrentSessionResponseSchema = z
	.object({
		absoluteExpiresAt: z.iso.datetime(),
		idleTimeoutSeconds: z.literal(900),
		permissions: z.array(AdminPermissionCodeSchema).max(9),
	})
	.strict();
export type AdminCurrentSessionResponse = z.infer<
	typeof AdminCurrentSessionResponseSchema
>;

export const AdminEmptyMutationRequestSchema = z.object({}).strict();
export type AdminEmptyMutationRequest = z.infer<
	typeof AdminEmptyMutationRequestSchema
>;

export const AdminRegistrationOptionsSchema = z
	.object({
		rp: z
			.object({
				id: z.string().min(1).max(253),
				name: z.string().trim().min(1).max(80),
			})
			.strict(),
		user: z
			.object({
				id: AdminWebAuthnBase64UrlSchema.max(128),
				name: z.string().min(1).max(80),
				displayName: z.string().min(1).max(80),
			})
			.strict(),
		challenge: AdminWebAuthnChallengeSchema,
		pubKeyCredParams: z
			.array(
				z
					.object({
						alg: z.number().int(),
						type: z.literal("public-key"),
					})
					.strict(),
			)
			.min(1)
			.max(20),
		timeout: z.number().int().min(1_000).max(300_000),
		excludeCredentials: z
			.array(
				z
					.object({
						id: AdminWebAuthnCredentialIdSchema,
						type: z.literal("public-key"),
						transports: z
							.array(AdminAuthenticatorTransportSchema)
							.max(7)
							.optional(),
					})
					.strict(),
			)
			.max(20),
		authenticatorSelection: z
			.object({
				residentKey: z.literal("required"),
				userVerification: z.literal("required"),
			})
			.strict(),
		attestation: z.literal("none"),
	})
	.strict();
export type AdminRegistrationOptions = z.infer<
	typeof AdminRegistrationOptionsSchema
>;

export const AdminCredentialEnrollOptionsResponseSchema = z
	.object({
		ceremonyId: z.uuid(),
		expiresAt: z.iso.datetime(),
		publicKey: AdminRegistrationOptionsSchema,
	})
	.strict();
export type AdminCredentialEnrollOptionsResponse = z.infer<
	typeof AdminCredentialEnrollOptionsResponseSchema
>;

export const AdminRegistrationResponseJSONSchema = z
	.object({
		id: AdminWebAuthnCredentialIdSchema,
		rawId: AdminWebAuthnCredentialIdSchema,
		response: z
			.object({
				clientDataJSON: AdminWebAuthnBase64UrlSchema.max(8_192),
				attestationObject: AdminWebAuthnBase64UrlSchema.max(90_000),
				transports: z
					.array(AdminAuthenticatorTransportSchema)
					.max(7)
					.optional(),
				authenticatorData: AdminWebAuthnBase64UrlSchema.max(16_384).optional(),
				publicKey: AdminWebAuthnBase64UrlSchema.max(16_384).optional(),
				publicKeyAlgorithm: z.number().int().optional(),
			})
			.strict(),
		type: z.literal("public-key"),
		clientExtensionResults: AdminClientExtensionResultsSchema,
		authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
	})
	.strict()
	.superRefine((response, context) => {
		if (response.id !== response.rawId) {
			context.addIssue({
				code: "custom",
				path: ["rawId"],
				message: "WebAuthn credential id 与 rawId 必须一致",
			});
		}
	});
export type AdminRegistrationResponseJSON = z.infer<
	typeof AdminRegistrationResponseJSONSchema
>;

export const AdminCredentialEnrollVerifyRequestSchema = z
	.object({
		ceremonyId: z.uuid(),
		response: AdminRegistrationResponseJSONSchema,
	})
	.strict();
export type AdminCredentialEnrollVerifyRequest = z.infer<
	typeof AdminCredentialEnrollVerifyRequestSchema
>;

export const AdminCredentialRecordSchema = z
	.object({
		credentialHandle: AdminCredentialHandleSchema,
		createdAt: z.iso.datetime(),
		lastUsedAt: z.iso.datetime().nullable(),
	})
	.strict();
export type AdminCredentialRecord = z.infer<typeof AdminCredentialRecordSchema>;

export const AdminCredentialsResponseSchema = z
	.object({ items: z.array(AdminCredentialRecordSchema).max(20) })
	.strict();
export type AdminCredentialsResponse = z.infer<
	typeof AdminCredentialsResponseSchema
>;

export const AdminCredentialEnrollVerifyResponseSchema = z
	.object({ credential: AdminCredentialRecordSchema })
	.strict();
export type AdminCredentialEnrollVerifyResponse = z.infer<
	typeof AdminCredentialEnrollVerifyResponseSchema
>;

export const AdminCredentialPathSchema = z
	.object({ credentialHandle: AdminCredentialHandleSchema })
	.strict();
export type AdminCredentialPath = z.infer<typeof AdminCredentialPathSchema>;

export const AdminConfigKeySchema = z.enum([
	"features.ai-assistance",
	"recommendations.rules",
	"recommendations.prompt",
	"coverage.default",
	"clients.minimum-version",
]);
export type AdminConfigKey = z.infer<typeof AdminConfigKeySchema>;

export const AdminConfigSchemaNameSchema = z.enum([
	"FEATURE_FLAGS_V1",
	"RECOMMENDATION_RULES_V1",
	"PROMPT_SETTINGS_V1",
	"COVERAGE_SETTINGS_V1",
	"MINIMUM_APP_VERSION_V1",
]);
export type AdminConfigSchemaName = z.infer<typeof AdminConfigSchemaNameSchema>;

export const AdminConfigClassificationSchema = z.enum(["PUBLIC", "INTERNAL"]);
export type AdminConfigClassification = z.infer<
	typeof AdminConfigClassificationSchema
>;

export const AdminConfigPublishChangeReasonSchema = z.enum([
	"ROUTINE_TUNING",
	"INCIDENT_RESPONSE",
	"RELEASE_COMPATIBILITY",
]);
export type AdminConfigPublishChangeReason = z.infer<
	typeof AdminConfigPublishChangeReasonSchema
>;

export const AdminConfigChangeReasonSchema = z.enum([
	...AdminConfigPublishChangeReasonSchema.options,
	"ROLLBACK",
]);
export type AdminConfigChangeReason = z.infer<
	typeof AdminConfigChangeReasonSchema
>;

export const AdminFeatureFlagsValueSchema = z
	.object({
		enabled: z.boolean(),
	})
	.strict();
export type AdminFeatureFlagsValue = z.infer<
	typeof AdminFeatureFlagsValueSchema
>;

const AdminRuleWeightSchema = z.number().min(0).max(95).multipleOf(0.0001);

export const DEFAULT_ADMIN_RECOMMENDATION_RULES_VALUE = Object.freeze({
	qualityWeight: 25,
	timeWeight: 25,
	budgetWeight: 20,
	intentWeight: 15,
	diversityWeight: 10,
	operationsAdjustmentMaximum: 5,
});

export const AdminRecommendationRulesValueSchema = z
	.object({
		qualityWeight: AdminRuleWeightSchema,
		timeWeight: AdminRuleWeightSchema,
		budgetWeight: AdminRuleWeightSchema,
		intentWeight: AdminRuleWeightSchema,
		diversityWeight: AdminRuleWeightSchema,
		operationsAdjustmentMaximum: z.number().min(0).max(5).multipleOf(0.0001),
	})
	.strict()
	.superRefine((value, context) => {
		const total =
			value.qualityWeight +
			value.timeWeight +
			value.budgetWeight +
			value.intentWeight +
			value.diversityWeight;
		if (Math.abs(total - 95) > 0.000001) {
			context.addIssue({
				code: "custom",
				path: ["diversityWeight"],
				message: "推荐规则前五项权重之和必须为 95",
			});
		}
	});
export type AdminRecommendationRulesValue = z.infer<
	typeof AdminRecommendationRulesValueSchema
>;

export const REGISTERED_INTENT_PROMPT_VERSIONS = Object.freeze([
	"intent-prompt-v1",
] as const);
export const REGISTERED_QWEN_MODEL_VERSIONS = Object.freeze([
	"qwen3.7-flash-2026-07-15",
] as const);

export const RegisteredIntentPromptVersionSchema = z.enum(
	REGISTERED_INTENT_PROMPT_VERSIONS,
);
export const RegisteredQwenModelVersionSchema = z.enum(
	REGISTERED_QWEN_MODEL_VERSIONS,
);

export const AdminPromptSettingsValueSchema = z
	.object({
		enabled: z.boolean(),
		promptVersion: RegisteredIntentPromptVersionSchema,
		modelVersion: RegisteredQwenModelVersionSchema,
		timeoutMs: z.number().int().min(500).max(2_500),
	})
	.strict();
export type AdminPromptSettingsValue = z.infer<
	typeof AdminPromptSettingsValueSchema
>;

export const AdminCoverageSettingsValueSchema = z
	.object({
		defaultRadiusMeters: z.number().int().min(200).max(10_000),
		maximumRadiusMeters: z.number().int().min(200).max(10_000),
		areaCode: z.literal("NATIONWIDE"),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.defaultRadiusMeters > value.maximumRadiusMeters) {
			context.addIssue({
				code: "custom",
				path: ["defaultRadiusMeters"],
				message: "默认半径不能大于最大半径",
			});
		}
	});
export type AdminCoverageSettingsValue = z.infer<
	typeof AdminCoverageSettingsValueSchema
>;

const AdminMinimumVersionSchema = z
	.string()
	.max(64)
	.regex(
		/^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/u,
	);

export const AdminMinimumAppVersionValueSchema = z
	.object({
		android: AdminMinimumVersionSchema,
		ios: AdminMinimumVersionSchema.optional(),
		miniprogram: AdminMinimumVersionSchema.optional(),
	})
	.strict();
export type AdminMinimumAppVersionValue = z.infer<
	typeof AdminMinimumAppVersionValueSchema
>;

export const AdminConfigValueSchema = z.union([
	AdminFeatureFlagsValueSchema,
	AdminRecommendationRulesValueSchema,
	AdminPromptSettingsValueSchema,
	AdminCoverageSettingsValueSchema,
	AdminMinimumAppVersionValueSchema,
]);
export type AdminConfigValue = z.infer<typeof AdminConfigValueSchema>;

const AdminConfigVersionMetadataShape = {
	version: z.number().int().positive().max(2_147_483_647),
	changeReason: AdminConfigChangeReasonSchema,
	createdAt: z.iso.datetime(),
	activatedAt: z.iso.datetime(),
} as const;

export const AdminFeatureFlagsConfigVersionSchema = z
	.object({
		configKey: z.literal("features.ai-assistance"),
		configSchema: z.literal("FEATURE_FLAGS_V1"),
		classification: z.literal("PUBLIC"),
		value: AdminFeatureFlagsValueSchema,
		...AdminConfigVersionMetadataShape,
	})
	.strict();

export const AdminRecommendationRulesConfigVersionSchema = z
	.object({
		configKey: z.literal("recommendations.rules"),
		configSchema: z.literal("RECOMMENDATION_RULES_V1"),
		classification: z.literal("INTERNAL"),
		value: AdminRecommendationRulesValueSchema,
		...AdminConfigVersionMetadataShape,
	})
	.strict();

export const AdminPromptSettingsConfigVersionSchema = z
	.object({
		configKey: z.literal("recommendations.prompt"),
		configSchema: z.literal("PROMPT_SETTINGS_V1"),
		classification: z.literal("INTERNAL"),
		value: AdminPromptSettingsValueSchema,
		...AdminConfigVersionMetadataShape,
	})
	.strict();

export const AdminCoverageSettingsConfigVersionSchema = z
	.object({
		configKey: z.literal("coverage.default"),
		configSchema: z.literal("COVERAGE_SETTINGS_V1"),
		classification: z.literal("PUBLIC"),
		value: AdminCoverageSettingsValueSchema,
		...AdminConfigVersionMetadataShape,
	})
	.strict();

export const AdminMinimumAppVersionConfigVersionSchema = z
	.object({
		configKey: z.literal("clients.minimum-version"),
		configSchema: z.literal("MINIMUM_APP_VERSION_V1"),
		classification: z.literal("PUBLIC"),
		value: AdminMinimumAppVersionValueSchema,
		...AdminConfigVersionMetadataShape,
	})
	.strict();

export const AdminConfigVersionSchema = z.discriminatedUnion("configKey", [
	AdminFeatureFlagsConfigVersionSchema,
	AdminRecommendationRulesConfigVersionSchema,
	AdminPromptSettingsConfigVersionSchema,
	AdminCoverageSettingsConfigVersionSchema,
	AdminMinimumAppVersionConfigVersionSchema,
]);
export type AdminConfigVersion = z.infer<typeof AdminConfigVersionSchema>;

export const AdminConfigListResponseSchema = z
	.object({ items: z.array(AdminConfigVersionSchema).max(5) })
	.strict();
export type AdminConfigListResponse = z.infer<
	typeof AdminConfigListResponseSchema
>;

export const AdminConfigHistoryResponseSchema = z
	.object({ items: z.array(AdminConfigVersionSchema).max(100) })
	.strict();
export type AdminConfigHistoryResponse = z.infer<
	typeof AdminConfigHistoryResponseSchema
>;

export const AdminConfigPathSchema = z
	.object({ configKey: AdminConfigKeySchema })
	.strict();
export type AdminConfigPath = z.infer<typeof AdminConfigPathSchema>;

export const AdminConfigHistoryLimitSchema = z
	.string()
	.regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
	.default("20")
	.transform(Number);
export const AdminConfigHistoryQuerySchema = z
	.object({ limit: AdminConfigHistoryLimitSchema })
	.strict();
export type AdminConfigHistoryQuery = z.infer<
	typeof AdminConfigHistoryQuerySchema
>;

const AdminConfigPublishBodyBaseShape = {
	expectedActiveVersion: z
		.number()
		.int()
		.positive()
		.max(2_147_483_647)
		.nullable(),
	changeReason: AdminConfigPublishChangeReasonSchema,
} as const;

export const AdminConfigPublishRequestSchema = z
	.object({
		...AdminConfigPublishBodyBaseShape,
		value: AdminConfigValueSchema,
	})
	.strict();
export type AdminConfigPublishRequest = z.infer<
	typeof AdminConfigPublishRequestSchema
>;

export const AdminConfigPublishCommandSchema = z.discriminatedUnion(
	"configKey",
	[
		z
			.object({
				configKey: z.literal("features.ai-assistance"),
				value: AdminFeatureFlagsValueSchema,
				...AdminConfigPublishBodyBaseShape,
			})
			.strict(),
		z
			.object({
				configKey: z.literal("recommendations.rules"),
				value: AdminRecommendationRulesValueSchema,
				...AdminConfigPublishBodyBaseShape,
			})
			.strict(),
		z
			.object({
				configKey: z.literal("recommendations.prompt"),
				value: AdminPromptSettingsValueSchema,
				...AdminConfigPublishBodyBaseShape,
			})
			.strict(),
		z
			.object({
				configKey: z.literal("coverage.default"),
				value: AdminCoverageSettingsValueSchema,
				...AdminConfigPublishBodyBaseShape,
			})
			.strict(),
		z
			.object({
				configKey: z.literal("clients.minimum-version"),
				value: AdminMinimumAppVersionValueSchema,
				...AdminConfigPublishBodyBaseShape,
			})
			.strict(),
	],
);
export type AdminConfigPublishCommand = z.infer<
	typeof AdminConfigPublishCommandSchema
>;

export const AdminConfigRollbackRequestSchema = z
	.object({
		expectedActiveVersion: z.number().int().positive().max(2_147_483_647),
		targetVersion: z.number().int().positive().max(2_147_483_647),
		changeReason: z.literal("ROLLBACK"),
	})
	.strict();
export type AdminConfigRollbackRequest = z.infer<
	typeof AdminConfigRollbackRequestSchema
>;

export const AdminAuditCursorSchema = AdminOpaqueTokenSchema;
export type AdminAuditCursor = z.infer<typeof AdminAuditCursorSchema>;

export const AdminAuditPageLimitSchema = z
	.string()
	.regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
	.default("50")
	.transform(Number);
export type AdminAuditPageLimit = z.infer<typeof AdminAuditPageLimitSchema>;

export const AdminAuditQuerySchema = z
	.object({
		cursor: AdminAuditCursorSchema.optional(),
		limit: AdminAuditPageLimitSchema,
	})
	.strict();
export type AdminAuditQuery = z.infer<typeof AdminAuditQuerySchema>;

export const AdminAuditActionSchema = z.enum([
	"ADMIN_LOGIN_FAILED",
	"ADMIN_LOGIN_SUCCEEDED",
	"ADMIN_WEBAUTHN_COUNTER_ROLLBACK",
	"ADMIN_SESSION_REVOKED",
	"ADMIN_CREDENTIAL_ENROLLED",
	"ADMIN_CREDENTIAL_REVOKED",
	"ADMIN_ROLE_GRANTED_AUDITOR",
	"ADMIN_ROLE_GRANTED_OPERATOR",
	"ADMIN_ROLE_GRANTED_ALGORITHM_ADMIN",
	"ADMIN_ROLE_GRANTED_SECURITY_ADMIN",
	"ADMIN_ROLE_REVOKED_AUDITOR",
	"ADMIN_ROLE_REVOKED_OPERATOR",
	"ADMIN_ROLE_REVOKED_ALGORITHM_ADMIN",
	"ADMIN_ROLE_REVOKED_SECURITY_ADMIN",
	"ADMIN_STATUS_CHANGED_ACTIVE",
	"ADMIN_STATUS_CHANGED_LOCKED",
	"ADMIN_STATUS_CHANGED_DISABLED",
	"ADMIN_BOOTSTRAP_COMPLETED",
	"ADMIN_CONFIG_PUBLISHED",
	"ADMIN_CONFIG_ROLLED_BACK",
]);
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;

export const AdminAuditEventSchema = z
	.object({
		auditEventId: z.uuid(),
		action: AdminAuditActionSchema,
		targetType: z.enum([
			"ADMIN_USER",
			"ADMIN_SESSION",
			"ADMIN_CREDENTIAL",
			"APP_CONFIG",
		]),
		occurredAt: z.iso.datetime(),
		configKey: AdminConfigKeySchema.optional(),
		newVersion: z.number().int().positive().max(2_147_483_647).optional(),
		sourceVersion: z
			.number()
			.int()
			.positive()
			.max(2_147_483_647)
			.nullable()
			.optional(),
		changeReason: AdminConfigChangeReasonSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const isConfigurationAction =
			value.action === "ADMIN_CONFIG_PUBLISHED" ||
			value.action === "ADMIN_CONFIG_ROLLED_BACK";
		const isConfigurationTarget = value.targetType === "APP_CONFIG";
		const isConfigurationEvent = isConfigurationTarget && isConfigurationAction;
		const hasEveryConfigurationField =
			value.configKey !== undefined &&
			value.newVersion !== undefined &&
			value.sourceVersion !== undefined &&
			value.changeReason !== undefined;
		const hasAnyConfigurationField =
			value.configKey !== undefined ||
			value.newVersion !== undefined ||
			value.sourceVersion !== undefined ||
			value.changeReason !== undefined;

		if (isConfigurationAction !== isConfigurationTarget) {
			context.addIssue({
				code: "custom",
				message: "配置审计动作与 APP_CONFIG 目标必须成对",
			});
		}
		if (isConfigurationEvent && !hasEveryConfigurationField) {
			context.addIssue({
				code: "custom",
				message: "配置审计事件必须包含固定的非敏感变更字段",
			});
		}
		if (!isConfigurationEvent && hasAnyConfigurationField) {
			context.addIssue({
				code: "custom",
				message: "非配置审计事件不得包含配置变更字段",
			});
			return;
		}
		if (
			value.action === "ADMIN_CONFIG_PUBLISHED" &&
			value.changeReason === "ROLLBACK"
		) {
			context.addIssue({
				code: "custom",
				path: ["changeReason"],
				message: "发布事件不能使用回滚原因",
			});
		}
		if (
			value.action === "ADMIN_CONFIG_ROLLED_BACK" &&
			value.changeReason !== undefined &&
			value.changeReason !== "ROLLBACK"
		) {
			context.addIssue({
				code: "custom",
				path: ["changeReason"],
				message: "回滚事件只能使用回滚原因",
			});
		}
	});
export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;

export const AdminAuditPageResponseSchema = z
	.object({
		items: z.array(AdminAuditEventSchema).max(100),
		nextCursor: AdminAuditCursorSchema.nullable(),
	})
	.strict();
export type AdminAuditPageResponse = z.infer<
	typeof AdminAuditPageResponseSchema
>;
