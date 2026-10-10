export type FavoriteGroup = "WANT_TO_GO" | "REGULAR";
export type HistoryAction =
	| "RECOMMENDATION_SHOWN"
	| "DETAIL_VIEWED"
	| "FAVORITE_ADDED"
	| "NAVIGATION_OPENED"
	| "PHONE_DIALER_OPENED"
	| "REROLL_REQUESTED";
export type MealPeriod = "BREAKFAST" | "LUNCH" | "DINNER";
export type PrivateFeedbackType =
	| "WANT_TO_EAT"
	| "ATE"
	| "LIKE"
	| "DISLIKE"
	| "TOO_FAR"
	| "TOO_EXPENSIVE"
	| "RECENTLY_ATE"
	| "AVOID_CUISINE";

export type PersistedPlacePresentation =
	| Readonly<{
			presentationStatus: "AVAILABLE";
			name: string;
			address: string | null;
			sourceLabel: string;
			dataMode: "LIVE" | "DEMO";
			openStatus: "OPEN" | "CLOSED" | "UNKNOWN";
			averageCostYuan: number | null;
			tags: readonly string[];
			resolvedAt: string;
	  }>
	| Readonly<{
			presentationStatus: "TEMPORARILY_UNAVAILABLE";
			retryable: true;
	  }>
	| Readonly<{
			presentationStatus: "RIGHTS_REVOKED";
			retryable: false;
	  }>;

export interface FavoriteRecord {
	readonly favoriteId: string;
	readonly group: FavoriteGroup;
	readonly createdAt: string;
	readonly presentation: PersistedPlacePresentation;
}

export interface FavoritesPage {
	readonly items: readonly FavoriteRecord[];
	readonly nextCursor: string | null;
}

export interface RecommendationHistoryItem {
	readonly historyId: string;
	readonly action: HistoryAction;
	readonly mealPeriod: MealPeriod;
	readonly occurredAt: string;
	readonly expiresAt: string;
	readonly presentation: PersistedPlacePresentation | null;
}

export interface RecommendationHistoryPage {
	readonly items: readonly RecommendationHistoryItem[];
	readonly nextCursor: string | null;
	readonly retentionDays: 90;
}

export interface PrivateFeedbackRecord {
	readonly feedbackId: string;
	readonly type: PrivateFeedbackType;
	readonly visibility: "PRIVATE";
	readonly createdAt: string;
	readonly presentation: PersistedPlacePresentation | null;
}

export interface PrivateFeedbackPage {
	readonly items: readonly PrivateFeedbackRecord[];
	readonly nextCursor: string | null;
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR = /^[A-Za-z0-9_-]{43}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FAVORITE_GROUPS = new Set<FavoriteGroup>(["WANT_TO_GO", "REGULAR"]);
const HISTORY_ACTIONS = new Set<HistoryAction>([
	"RECOMMENDATION_SHOWN",
	"DETAIL_VIEWED",
	"FAVORITE_ADDED",
	"NAVIGATION_OPENED",
	"PHONE_DIALER_OPENED",
	"REROLL_REQUESTED",
]);
const MEAL_PERIODS = new Set<MealPeriod>(["BREAKFAST", "LUNCH", "DINNER"]);
const PRIVATE_FEEDBACK_TYPES = new Set<PrivateFeedbackType>([
	"WANT_TO_EAT",
	"ATE",
	"LIKE",
	"DISLIKE",
	"TOO_FAR",
	"TOO_EXPENSIVE",
	"RECENTLY_ATE",
	"AVOID_CUISINE",
]);

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail();
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
	const actual = Object.keys(value).sort().join(",");
	if (actual !== [...keys].sort().join(",")) fail();
}

function fail(): never {
	throw new Error("PERSISTENCE_RESPONSE_INVALID");
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) fail();
	return value;
}

function timestamp(value: unknown): string {
	if (
		typeof value !== "string" ||
		!ISO_TIMESTAMP.test(value) ||
		Number.isNaN(Date.parse(value))
	) {
		fail();
	}
	return value;
}

function nullableCursor(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !CURSOR.test(value)) fail();
	return value;
}

function enumValue<Value extends string>(
	value: unknown,
	options: Set<Value>,
): Value {
	if (typeof value !== "string" || !options.has(value as Value)) fail();
	return value as Value;
}

function nullableString(value: unknown, maximum: number): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || [...value].length > maximum) fail();
	return value;
}

function presentation(value: unknown): PersistedPlacePresentation {
	const source = asRecord(value);
	if (source.presentationStatus === "TEMPORARILY_UNAVAILABLE") {
		exact(source, ["presentationStatus", "retryable"]);
		if (source.retryable !== true) fail();
		return Object.freeze({
			presentationStatus: "TEMPORARILY_UNAVAILABLE",
			retryable: true,
		});
	}
	if (source.presentationStatus === "RIGHTS_REVOKED") {
		exact(source, ["presentationStatus", "retryable"]);
		if (source.retryable !== false) fail();
		return Object.freeze({
			presentationStatus: "RIGHTS_REVOKED",
			retryable: false,
		});
	}
	if (source.presentationStatus !== "AVAILABLE") fail();
	exact(source, [
		"presentationStatus",
		"name",
		"address",
		"sourceLabel",
		"dataMode",
		"openStatus",
		"averageCostYuan",
		"tags",
		"resolvedAt",
	]);
	if (
		typeof source.name !== "string" ||
		[...source.name.trim()].length < 1 ||
		[...source.name.trim()].length > 160 ||
		typeof source.sourceLabel !== "string" ||
		[...source.sourceLabel.trim()].length < 1 ||
		[...source.sourceLabel.trim()].length > 80 ||
		(source.dataMode !== "LIVE" && source.dataMode !== "DEMO") ||
		(source.openStatus !== "OPEN" &&
			source.openStatus !== "CLOSED" &&
			source.openStatus !== "UNKNOWN") ||
		!Array.isArray(source.tags) ||
		source.tags.length > 8 ||
		source.tags.some(
			(item) =>
				typeof item !== "string" ||
				[...item.trim()].length < 1 ||
				[...item.trim()].length > 40,
		)
	) {
		fail();
	}
	const averageCost = source.averageCostYuan;
	if (
		averageCost !== null &&
		(typeof averageCost !== "number" ||
			!Number.isFinite(averageCost) ||
			averageCost < 0 ||
			averageCost > 20_000)
	) {
		fail();
	}
	return Object.freeze({
		presentationStatus: "AVAILABLE",
		name: source.name.trim(),
		address: nullableString(source.address, 240),
		sourceLabel: source.sourceLabel.trim(),
		dataMode: source.dataMode,
		openStatus: source.openStatus,
		averageCostYuan: averageCost,
		tags: Object.freeze(source.tags.map((item) => (item as string).trim())),
		resolvedAt: timestamp(source.resolvedAt),
	});
}

function nullablePresentation(
	value: unknown,
): PersistedPlacePresentation | null {
	return value === null ? null : presentation(value);
}

function favorite(value: unknown): FavoriteRecord {
	const source = asRecord(value);
	exact(source, ["favoriteId", "group", "createdAt", "presentation"]);
	return Object.freeze({
		favoriteId: uuid(source.favoriteId),
		group: enumValue(source.group, FAVORITE_GROUPS),
		createdAt: timestamp(source.createdAt),
		presentation: presentation(source.presentation),
	});
}

function history(value: unknown): RecommendationHistoryItem {
	const source = asRecord(value);
	exact(source, [
		"historyId",
		"action",
		"mealPeriod",
		"occurredAt",
		"expiresAt",
		"presentation",
	]);
	const occurredAt = timestamp(source.occurredAt);
	const expiresAt = timestamp(source.expiresAt);
	if (
		Date.parse(expiresAt) - Date.parse(occurredAt) !==
		90 * 24 * 60 * 60 * 1_000
	)
		fail();
	return Object.freeze({
		historyId: uuid(source.historyId),
		action: enumValue(source.action, HISTORY_ACTIONS),
		mealPeriod: enumValue(source.mealPeriod, MEAL_PERIODS),
		occurredAt,
		expiresAt,
		presentation: nullablePresentation(source.presentation),
	});
}

function privateFeedback(value: unknown): PrivateFeedbackRecord {
	const source = asRecord(value);
	exact(source, [
		"feedbackId",
		"type",
		"visibility",
		"createdAt",
		"presentation",
	]);
	if (source.visibility !== "PRIVATE") fail();
	return Object.freeze({
		feedbackId: uuid(source.feedbackId),
		type: enumValue(source.type, PRIVATE_FEEDBACK_TYPES),
		visibility: "PRIVATE",
		createdAt: timestamp(source.createdAt),
		presentation: nullablePresentation(source.presentation),
	});
}

function parseItems<Value>(
	value: unknown,
	parse: (item: unknown) => Value,
): readonly Value[] {
	if (!Array.isArray(value) || value.length > 50) fail();
	return Object.freeze(value.map(parse));
}

export function parseFavoritesPage(value: unknown): FavoritesPage {
	const source = asRecord(value);
	exact(source, ["items", "nextCursor"]);
	return Object.freeze({
		items: parseItems(source.items, favorite),
		nextCursor: nullableCursor(source.nextCursor),
	});
}

export function parseFavoriteRecord(value: unknown): FavoriteRecord {
	return favorite(value);
}

export function parseHistoryPage(value: unknown): RecommendationHistoryPage {
	const source = asRecord(value);
	exact(source, ["items", "nextCursor", "retentionDays"]);
	if (source.retentionDays !== 90) fail();
	return Object.freeze({
		items: parseItems(source.items, history),
		nextCursor: nullableCursor(source.nextCursor),
		retentionDays: 90,
	});
}

export function parsePrivateFeedbackPage(value: unknown): PrivateFeedbackPage {
	const source = asRecord(value);
	exact(source, ["items", "nextCursor"]);
	return Object.freeze({
		items: parseItems(source.items, privateFeedback),
		nextCursor: nullableCursor(source.nextCursor),
	});
}

export function parsePrivateFeedbackRecord(
	value: unknown,
): PrivateFeedbackRecord {
	return privateFeedback(value);
}

export function isContractUuid(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

export function isResultToken(value: unknown): value is string {
	return typeof value === "string" && CURSOR.test(value);
}
