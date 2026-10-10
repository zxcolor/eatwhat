import {
	type Coordinate,
	CUISINE_PREFERENCES,
	type CuisinePreference,
	DEFAULT_PREFERENCE_VECTOR,
	type DecisionAccessPolicy,
	type DecisionForm,
	type LocationSearchPlace,
	type LocationSearchResponse,
	type RecommendationActions,
	type RecommendationContext,
	type RecommendationProfile,
	type RecommendationReason,
	type RecommendationResponse,
	type RecommendationResult,
	type WeatherApplication,
} from "./types";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESULT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PROVIDER_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/u;
const PHONE_PATTERN = /(?:^|\D)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?:\D|$)/u;
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u;
const COORDINATE_PATTERN =
	/(?:^|\s)[+-]?(?:\d{1,3}(?:\.\d+)?)\s*[,，]\s*[+-]?(?:\d{1,3}(?:\.\d+)?)(?:\s|$)/u;
const CUISINES = new Set<string>(CUISINE_PREFERENCES);

export type ValidationResult =
	| { readonly valid: true }
	| { readonly valid: false; readonly message: string };

export type LocationQueryValidation =
	| { readonly valid: true; readonly query: string }
	| { readonly valid: false; readonly message: string };

export function validateDecisionForm(
	form: DecisionForm,
	policy?: DecisionAccessPolicy,
): ValidationResult {
	if (form.location === null) return invalid("请先定位或手动选择地点");
	try {
		parseCoordinate(form.location.coordinate);
		oneOf(form.mealPeriod, ["BREAKFAST", "LUNCH", "DINNER"] as const);
		oneOf(form.target, ["MEAL", "MILK_TEA", "COFFEE", "DESSERT"] as const);
		oneOf(form.decisionMode, ["QUICK", "GUIDED"] as const);
		oneOf(form.travelMode, ["WALK", "BIKE", "TRANSIT"] as const);
		oneOf(form.explorationMode, ["SAFE", "BALANCED", "ADVENTUROUS"] as const);
		parseWeatherRequest(form.weatherContext);
		const vector = object(form.preferenceVector);
		exactKeys(vector, Object.keys(DEFAULT_PREFERENCE_VECTOR));
		for (const value of Object.values(vector)) integer(value, 0, 100);
	} catch {
		return invalid("推荐条件格式有误，请重新选择");
	}
	if (form.budgetMaxYuan !== null && !integerIn(form.budgetMaxYuan, 1, 2_000)) {
		return invalid("人均预算需在 1–2000 元之间");
	}
	if (!integerIn(form.availableMinutes, 15, 240)) {
		return invalid("可用时间需在 15–240 分钟之间");
	}
	if (!integerIn(form.radiusMeters, 200, 10_000)) {
		return invalid("搜索距离需在 200 米–10 公里之间");
	}
	if (form.partySize !== 1) return invalid("当前仅支持单人决策");
	if (policy !== undefined) {
		const maximum =
			policy.recommendationDefaults?.maximumRadiusMeters ?? 10_000;
		if (form.radiusMeters > maximum)
			return invalid(
				`当前服务最远支持 ${maximum} 米，你选择了 ${form.radiusMeters} 米。请调整最远距离后重试。`,
			);
		const capabilities =
			policy.state === "TRUSTED_COMPATIBLE" && policy.recommendationsEnabled
				? policy.specialtyCapabilities
				: undefined;
		if (
			(form.mealPeriod === "BREAKFAST" &&
				capabilities?.breakfastProfileEnabled !== true) ||
			(form.mealPeriod === "DINNER" &&
				capabilities?.dinnerProfileEnabled !== true)
		)
			return invalid("该餐段专项当前未开放，请先选择午餐");
		if (
			(form.target === "MILK_TEA" && capabilities?.milkTeaEnabled !== true) ||
			(form.target === "COFFEE" && capabilities?.coffeeEnabled !== true) ||
			(form.target === "DESSERT" && capabilities?.dessertEnabled !== true)
		)
			return invalid("该专项推荐当前未开放，请先使用普通用餐模式");
		if (
			form.weatherContext.kind === "USER_REPORTED" &&
			capabilities?.userReportedWeatherEnabled !== true
		)
			return invalid("手动体感推荐当前未开放");
	}
	if (form.preferredCuisines.length > 20 || form.excludedCuisines.length > 20) {
		return invalid("菜系选项最多各 20 项");
	}
	if (
		form.preferredCuisines.some((item) =>
			form.excludedCuisines.includes(item),
		) ||
		![...form.preferredCuisines, ...form.excludedCuisines].every((item) =>
			CUISINES.has(item),
		)
	) {
		return invalid("偏好菜系和排除菜系不能重复");
	}
	return { valid: true };
}

export function validateLocationSearchQuery(
	value: string,
): LocationQueryValidation {
	if ([...value].some(isControlCharacter)) {
		return { valid: false, message: "请输入单行地点关键词，不要包含控制字符" };
	}
	const query = value.trim().replace(/\s+/gu, " ");
	if ([...query].length < 2)
		return { valid: false, message: "请至少输入 2 个字符" };
	if ([...query].length > 80)
		return { valid: false, message: "地点关键词最多 80 个字符" };
	if (query.includes("|"))
		return { valid: false, message: "地点关键词不能包含管道符号" };
	if (COORDINATE_PATTERN.test(query)) {
		return { valid: false, message: "请搜索地点名称或地址，不要输入经纬度" };
	}
	if (PHONE_PATTERN.test(query.replace(/[\s-]/gu, ""))) {
		return { valid: false, message: "请勿在地点搜索中输入手机号" };
	}
	if (EMAIL_PATTERN.test(query))
		return { valid: false, message: "请勿在地点搜索中输入邮箱地址" };
	return { valid: true, query };
}

export function buildRecommendationContext(
	form: DecisionForm,
	aiAssistanceEnabled: boolean,
	now: () => Date = () => new Date(),
): RecommendationContext {
	const validation = validateDecisionForm(form);
	if (!validation.valid || form.location === null) {
		throw new Error(
			validation.valid ? "DECISION_LOCATION_REQUIRED" : validation.message,
		);
	}
	const context = {
		target: form.target,
		weatherContext: Object.freeze({ ...form.weatherContext }),
		preferenceVector: Object.freeze({ ...form.preferenceVector }),
		location: copyCoordinate(form.location.coordinate),
		mealPeriod: form.mealPeriod,
		decisionMode: form.decisionMode,
		travelMode: form.travelMode,
		explorationMode: form.explorationMode,
		aiAssistanceEnabled,
		budgetMaxYuan: form.budgetMaxYuan,
		availableMinutes: form.availableMinutes,
		radiusMeters: form.radiusMeters,
		partySize: 1,
		excludedCuisines: [...form.excludedCuisines].sort() as CuisinePreference[],
		preferredCuisines: [
			...form.preferredCuisines,
		].sort() as CuisinePreference[],
		requestTime: now().toISOString(),
	} satisfies Omit<RecommendationContext, "locationLabel">;
	const label = form.location.label.trim().slice(0, 80);
	return label.length === 0
		? Object.freeze(context)
		: Object.freeze({ ...context, locationLabel: label });
}

export function validateRecommendationContext(
	context: RecommendationContext,
): void {
	const validation = validateDecisionForm({
		...context,
		target: context.target ?? "MEAL",
		weatherContext: context.weatherContext ?? { kind: "NONE" },
		preferenceVector: context.preferenceVector ?? DEFAULT_PREFERENCE_VECTOR,
		location: {
			label: context.locationLabel ?? "手动地点",
			coordinate: context.location,
			isDemonstration: false,
			isApproximate: false,
		},
		aiAssistancePreferred: context.aiAssistanceEnabled,
	});
	if (!validation.valid || typeof context.aiAssistanceEnabled !== "boolean")
		throw new Error("RECOMMENDATION_CONTEXT_INVALID");
	isoDateTime(context.requestTime);
}

export function parseLocationSearchResponse(
	value: unknown,
): LocationSearchResponse {
	const body = object(value);
	exactKeys(body, ["requestId", "dataSource", "dataMode", "results"]);
	const requestId = uuid(body.requestId);
	const dataSource = string(body.dataSource, 2, 32);
	if (!PROVIDER_PATTERN.test(dataSource)) fail();
	const dataMode = oneOf(body.dataMode, ["LIVE", "DEMO"] as const);
	const items = array(body.results, 5).map(parseLocationSearchPlace);
	const ranks = new Set(items.map((item) => item.providerRank));
	if (ranks.size !== items.length) fail();
	return Object.freeze({
		requestId,
		dataSource,
		dataMode,
		results: Object.freeze(items),
	});
}

export function parseRecommendationResponse(
	value: unknown,
	context: RecommendationContext,
): RecommendationResponse {
	const body = object(value);
	exactKeys(body, [
		"requestId",
		"generatedAt",
		"coverage",
		"dataRightsMode",
		"ruleVersion",
		"promptVersion",
		"modelVersion",
		"aiFallbackUsed",
		"results",
		"notice",
		...(body.profile === undefined ? [] : ["profile"]),
		...(body.weatherApplication === undefined ? [] : ["weatherApplication"]),
		...(body.rulesConfigVersion === undefined ? [] : ["rulesConfigVersion"]),
	]);
	const response: RecommendationResponse = Object.freeze({
		profile: parseProfile(body.profile, context),
		weatherApplication: parseWeatherApplication(
			body.weatherApplication,
			context,
		),
		...(body.rulesConfigVersion === undefined
			? {}
			: {
					rulesConfigVersion:
						body.rulesConfigVersion === null
							? null
							: integer(body.rulesConfigVersion, 1, Number.MAX_SAFE_INTEGER),
				}),
		requestId: uuid(body.requestId),
		generatedAt: isoDateTime(body.generatedAt),
		coverage: literal(body.coverage, "NATIONWIDE"),
		dataRightsMode: oneOf(body.dataRightsMode, [
			"LIVE_DISPLAY_ONLY",
			"LICENSED_ENRICHMENT",
		] as const),
		ruleVersion: string(body.ruleVersion, 1, 160),
		promptVersion: string(body.promptVersion, 1, 160),
		modelVersion: string(body.modelVersion, 1, 160),
		aiFallbackUsed: boolean(body.aiFallbackUsed),
		results: Object.freeze(
			array(body.results, 3).map(parseRecommendationResult),
		),
		notice: nullableString(body.notice, 500),
	});
	const aiAllowed =
		context.aiAssistanceEnabled &&
		(context.target ?? "MEAL") === "MEAL" &&
		context.mealPeriod === "LUNCH" &&
		(context.weatherContext?.kind ?? "NONE") === "NONE";
	if (
		!aiAllowed &&
		(response.aiFallbackUsed ||
			response.results.some((result) => result.aiAssisted))
	)
		fail();
	const tokens = new Set(response.results.map((result) => result.resultToken));
	if (tokens.size !== response.results.length) fail();
	response.results.forEach((result, index) => {
		if (
			result.rank !== index + 1 ||
			!respectsContext(result, response.dataRightsMode, context)
		)
			fail();
	});
	return response;
}

export function isResultToken(value: unknown): value is string {
	return typeof value === "string" && RESULT_TOKEN_PATTERN.test(value);
}

function parseWeatherRequest(value: unknown): void {
	const source = object(value);
	if (source.kind === "NONE") {
		exactKeys(source, ["kind"]);
		return;
	}
	exactKeys(source, ["kind", "preference"]);
	literal(source.kind, "USER_REPORTED");
	oneOf(source.preference, [
		"MINIMIZE_EXPOSURE",
		"WARMING",
		"COOLING",
	] as const);
}

function parseProfile(
	value: unknown,
	context: RecommendationContext,
): RecommendationProfile {
	const profile = object(
		value === undefined
			? {
					target: "MEAL",
					family: "MEAL_LEGACY",
					version: "meal-legacy-v1",
					providerCapabilityRequired: false,
				}
			: value,
	);
	exactKeys(profile, [
		"target",
		"family",
		"version",
		"providerCapabilityRequired",
	]);
	const target = oneOf(profile.target, [
		"MEAL",
		"MILK_TEA",
		"COFFEE",
		"DESSERT",
	] as const);
	const family = oneOf(profile.family, [
		"MEAL_LEGACY",
		"MEAL_BREAKFAST",
		"MEAL_LUNCH",
		"MEAL_DINNER",
		"MILK_TEA",
		"COFFEE",
		"DESSERT",
	] as const);
	const version = string(profile.version, 1, 80);
	const providerCapabilityRequired = boolean(
		profile.providerCapabilityRequired,
	);
	const requestedTarget = context.target ?? "MEAL";
	const expectedFamily =
		requestedTarget === "MEAL" ? `MEAL_${context.mealPeriod}` : requestedTarget;
	const legacyAllowed =
		requestedTarget === "MEAL" &&
		context.mealPeriod === "LUNCH" &&
		(context.weatherContext?.kind ?? "NONE") === "NONE";
	if (
		target !== requestedTarget ||
		(family !== expectedFamily && !(family === "MEAL_LEGACY" && legacyAllowed))
	)
		fail();
	const prefixes = {
		MEAL_LEGACY: "meal-legacy",
		MEAL_BREAKFAST: "meal-breakfast",
		MEAL_LUNCH: "meal-lunch",
		MEAL_DINNER: "meal-dinner",
		MILK_TEA: "milk-tea",
		COFFEE: "coffee",
		DESSERT: "dessert",
	} as const;
	if (
		providerCapabilityRequired !== (target !== "MEAL") ||
		!new RegExp(`^${prefixes[family]}-v[1-9]\\d*$`, "u").test(version)
	)
		fail();
	return Object.freeze({ target, family, version, providerCapabilityRequired });
}

function parseWeatherApplication(
	value: unknown,
	context: RecommendationContext,
): WeatherApplication {
	const application = object(
		value === undefined
			? { kind: "NONE", version: "weather-none-v1", queryModifier: null }
			: value,
	);
	const request = context.weatherContext ?? { kind: "NONE" };
	const version = string(application.version, 1, 80);
	if (request.kind === "NONE") {
		exactKeys(application, ["kind", "version", "queryModifier"]);
		if (
			application.kind !== "NONE" ||
			application.queryModifier !== null ||
			!/^weather-none-v[1-9]\d*$/u.test(version)
		)
			fail();
		return Object.freeze({ kind: "NONE", version, queryModifier: null });
	}
	exactKeys(application, ["kind", "version", "preference", "queryModifier"]);
	const modifiers = {
		MINIMIZE_EXPOSURE: "MINIMIZE_OUTDOOR_EXPOSURE",
		WARMING: "PREFER_WARMING_OPTIONS",
		COOLING: "PREFER_COOLING_OPTIONS",
	} as const;
	const queryModifier = modifiers[request.preference];
	if (
		application.kind !== "USER_REPORTED" ||
		application.preference !== request.preference ||
		application.queryModifier !== queryModifier ||
		!/^user-reported-weather-v[1-9]\d*$/u.test(version)
	)
		fail();
	return Object.freeze({
		kind: "USER_REPORTED",
		version,
		preference: request.preference,
		queryModifier,
	});
}

function parseLocationSearchPlace(value: unknown): LocationSearchPlace {
	const item = object(value);
	exactKeys(item, [
		"name",
		"address",
		"location",
		"sourceLabel",
		"providerRank",
	]);
	return Object.freeze({
		name: string(item.name, 1, 120),
		address: nullableString(item.address, 200),
		location: parseCoordinate(item.location),
		sourceLabel: string(item.sourceLabel, 1, 80),
		providerRank: integer(item.providerRank, 1, 5),
	});
}

function parseRecommendationResult(value: unknown): RecommendationResult {
	const item = object(value);
	exactKeys(item, [
		"provider",
		"resultToken",
		"dataMode",
		"actions",
		"name",
		"address",
		"rank",
		"fitScore",
		"sourceRating",
		"averageCostYuan",
		"distanceMeters",
		"estimatedTravelMinutes",
		"estimatedMealMinutes",
		"openStatus",
		"tags",
		"imageUrl",
		"phone",
		"location",
		"reasons",
		"warnings",
		"confidence",
		"aiAssisted",
		"sourceAttribution",
	]);
	const provider = string(item.provider, 2, 32);
	if (!PROVIDER_PATTERN.test(provider) || !isResultToken(item.resultToken))
		fail();
	return Object.freeze({
		provider,
		resultToken: item.resultToken,
		dataMode: oneOf(item.dataMode, ["LIVE", "DEMO"] as const),
		actions: parseActions(item.actions),
		name: string(item.name, 1, 120),
		address: stringAllowEmpty(item.address, 300),
		rank: integer(item.rank, 1, 3),
		fitScore: nullableNumber(item.fitScore, 0, 100),
		sourceRating: nullableNumber(item.sourceRating, 0, 5),
		averageCostYuan: nullableNumber(
			item.averageCostYuan,
			0,
			Number.MAX_SAFE_INTEGER,
		),
		distanceMeters: number(item.distanceMeters, 0, Number.MAX_SAFE_INTEGER),
		estimatedTravelMinutes: number(
			item.estimatedTravelMinutes,
			0,
			Number.MAX_SAFE_INTEGER,
		),
		estimatedMealMinutes: number(
			item.estimatedMealMinutes,
			Number.MIN_VALUE,
			Number.MAX_SAFE_INTEGER,
		),
		openStatus: oneOf(item.openStatus, ["OPEN", "CLOSED", "UNKNOWN"] as const),
		tags: Object.freeze(array(item.tags, 20).map((tag) => string(tag, 1, 40))),
		imageUrl: httpsUrlOrNull(item.imageUrl),
		phone: nullableString(item.phone, 80),
		location: parseCoordinate(item.location),
		reasons: Object.freeze(array(item.reasons, 4, 1).map(parseReason)),
		warnings: Object.freeze(
			array(item.warnings, 20).map((warning) => stringAllowEmpty(warning, 200)),
		),
		confidence: oneOf(item.confidence, ["LOW", "MEDIUM", "HIGH"] as const),
		aiAssisted: boolean(item.aiAssisted),
		sourceAttribution: string(item.sourceAttribution, 1, 100),
	});
}

function parseActions(value: unknown): RecommendationActions {
	const actions = object(value);
	exactKeys(actions, ["navigate", "call", "copyAddress", "share"]);
	return Object.freeze({
		navigate: boolean(actions.navigate),
		call: boolean(actions.call),
		copyAddress: boolean(actions.copyAddress),
		share: boolean(actions.share),
	});
}

function parseReason(value: unknown): RecommendationReason {
	const reason = object(value);
	exactKeys(reason, ["code", "text"]);
	return Object.freeze({
		code: oneOf(reason.code, [
			"TIME_FIT",
			"BUDGET_FIT",
			"DISTANCE_FIT",
			"MEAL_FIT",
			"QUALITY_SIGNAL",
			"DIVERSITY",
		] as const),
		text: string(reason.text, 1, 120),
	});
}

function parseCoordinate(value: unknown): Coordinate {
	const coordinate = object(value);
	const keys = Object.keys(coordinate).sort();
	const expected =
		coordinate.accuracyMeters === undefined
			? ["crs", "latitude", "longitude"]
			: ["accuracyMeters", "crs", "latitude", "longitude"];
	if (
		keys.length !== expected.length ||
		keys.some((key, index) => key !== expected[index])
	)
		fail();
	const base = {
		latitude: number(coordinate.latitude, -90, 90),
		longitude: number(coordinate.longitude, -180, 180),
		crs: oneOf(coordinate.crs, ["WGS84", "GCJ02"] as const),
	};
	return coordinate.accuracyMeters === undefined
		? Object.freeze(base)
		: Object.freeze({
				...base,
				accuracyMeters: number(coordinate.accuracyMeters, 0, 10_000),
			});
}

function respectsContext(
	result: RecommendationResult,
	rightsMode: RecommendationResponse["dataRightsMode"],
	context: RecommendationContext,
): boolean {
	if (rightsMode === "LIVE_DISPLAY_ONLY" && result.fitScore !== null)
		return false;
	if (
		result.openStatus === "CLOSED" ||
		result.distanceMeters > context.radiusMeters
	)
		return false;
	if (
		context.budgetMaxYuan !== null &&
		result.averageCostYuan !== null &&
		result.averageCostYuan > context.budgetMaxYuan
	)
		return false;
	const excluded = context.excludedCuisines
		.map(normalizeCuisine)
		.flatMap((value) =>
			value === "川湘菜" ? ["川湘菜", "川菜", "湘菜"] : [value],
		);
	return !result.tags.some((tag) => {
		const normalized = normalizeCuisine(tag);
		return excluded.some(
			(item) => normalized === item || normalized.includes(item),
		);
	});
}

function copyCoordinate(value: Coordinate): Coordinate {
	return value.accuracyMeters === undefined
		? { latitude: value.latitude, longitude: value.longitude, crs: value.crs }
		: {
				latitude: value.latitude,
				longitude: value.longitude,
				accuracyMeters: value.accuracyMeters,
				crs: value.crs,
			};
}

function invalid(message: string): ValidationResult {
	return { valid: false, message };
}

function normalizeCuisine(value: string): string {
	return value.trim().toLocaleLowerCase("zh-CN");
}

function isControlCharacter(value: string): boolean {
	const code = value.codePointAt(0) ?? 0;
	return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function integerIn(value: number, minimum: number, maximum: number): boolean {
	return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail();
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	)
		fail();
}

function array(value: unknown, maximum: number, minimum = 0): unknown[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
		fail();
	return value;
}

function string(value: unknown, minimum: number, maximum: number): string {
	if (
		typeof value !== "string" ||
		[...value.trim()].length < minimum ||
		[...value].length > maximum
	)
		fail();
	return value;
}

function stringAllowEmpty(value: unknown, maximum: number): string {
	if (typeof value !== "string" || [...value].length > maximum) fail();
	return value;
}

function nullableString(value: unknown, maximum: number): string | null {
	return value === null ? null : stringAllowEmpty(value, maximum);
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") fail();
	return value;
}

function number(value: unknown, minimum: number, maximum: number): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < minimum ||
		value > maximum
	)
		fail();
	return value;
}

function nullableNumber(
	value: unknown,
	minimum: number,
	maximum: number,
): number | null {
	return value === null ? null : number(value, minimum, maximum);
}

function integer(value: unknown, minimum: number, maximum: number): number {
	const parsed = number(value, minimum, maximum);
	if (!Number.isInteger(parsed)) fail();
	return parsed;
}

function oneOf<const T extends readonly string[]>(
	value: unknown,
	options: T,
): T[number] {
	if (typeof value !== "string" || !options.includes(value)) fail();
	return value as T[number];
}

function literal<const T extends string>(value: unknown, expected: T): T {
	if (value !== expected) fail();
	return expected;
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail();
	return value;
}

function isoDateTime(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ||
		Number.isNaN(Date.parse(value))
	)
		fail();
	return value;
}

function httpsUrlOrNull(value: unknown): string | null {
	if (value === null) return null;
	const text = string(value, 1, 2_048);
	if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#][^\s]*)?$/u.test(text))
		fail();
	return text;
}

function fail(): never {
	throw new Error("CONTRACT_RESPONSE_INVALID");
}
