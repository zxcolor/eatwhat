export interface PublicRecommendationDefaults {
	readonly areaCode: "NATIONWIDE";
	readonly defaultRadiusMeters: number;
	readonly maximumRadiusMeters: number;
}

export interface PublicMinimumSupportedVersions {
	readonly android: string;
	readonly ios?: string;
	readonly miniprogram?: string;
}

export interface SpecialtyCapabilities {
	readonly breakfastProfileEnabled: boolean;
	readonly dinnerProfileEnabled: boolean;
	readonly milkTeaEnabled: boolean;
	readonly coffeeEnabled: boolean;
	readonly dessertEnabled: boolean;
	readonly userReportedWeatherEnabled: boolean;
}

export const DISABLED_SPECIALTY_CAPABILITIES: SpecialtyCapabilities =
	Object.freeze({
		breakfastProfileEnabled: false,
		dinnerProfileEnabled: false,
		milkTeaEnabled: false,
		coffeeEnabled: false,
		dessertEnabled: false,
		userReportedWeatherEnabled: false,
	});

export interface PersistenceCapabilities {
	readonly favoritesEnabled: boolean;
	readonly historyEnabled: boolean;
	readonly privateFeedbackEnabled: boolean;
	readonly savedResourceIdsEnabled: boolean;
}

export interface AuthCapabilities {
	readonly accountsEnabled: boolean;
	readonly registrationEnabled: boolean;
	readonly phoneEnabled: boolean;
	readonly wechatEnabled: boolean;
	readonly emailEnabled: boolean;
	readonly qqEnabled: boolean;
	readonly dataExportEnabled: boolean;
}

export interface ServiceCapabilities {
	readonly groupRecommendationsEnabled: false;
	readonly recommendationsEnabled: boolean;
	readonly locationSearchEnabled: boolean;
	readonly placeSearchEnabled: boolean;
}

export interface MiniProgramFeatureConfig {
	readonly recommendationDefaults: PublicRecommendationDefaults | null;
	readonly minimumSupportedVersions: PublicMinimumSupportedVersions | null;
	readonly specialtyCapabilities: SpecialtyCapabilities;
	readonly rulesConfigVersion: number | null;
	readonly coverageName: string;
	readonly dataRightsMode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
	readonly aiEnabled: boolean;
	readonly accountsEnabled: boolean;
	readonly favoritesEnabled: boolean;
	readonly supportFeedbackEnabled: boolean;
	readonly minimumSupportedVersion: string;
	readonly ruleVersion: string;
	readonly promptVersion: string;
	readonly modelVersion: string;
	readonly persistenceCapabilities: PersistenceCapabilities;
	readonly authCapabilities: AuthCapabilities;
	readonly serviceCapabilities: ServiceCapabilities;
}

export const DISABLED_PERSISTENCE_CAPABILITIES: PersistenceCapabilities =
	Object.freeze({
		favoritesEnabled: false,
		historyEnabled: false,
		privateFeedbackEnabled: false,
		savedResourceIdsEnabled: false,
	});

export const DISABLED_AUTH_CAPABILITIES: AuthCapabilities = Object.freeze({
	accountsEnabled: false,
	registrationEnabled: false,
	phoneEnabled: false,
	wechatEnabled: false,
	emailEnabled: false,
	qqEnabled: false,
	dataExportEnabled: false,
});

export const DISABLED_SERVICE_CAPABILITIES: ServiceCapabilities = Object.freeze(
	{
		groupRecommendationsEnabled: false,
		recommendationsEnabled: false,
		locationSearchEnabled: false,
		placeSearchEnabled: false,
	},
);

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("FEATURE_CONFIG_INVALID");
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new Error("FEATURE_CONFIG_INVALID");
	}
}

function bool(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("FEATURE_CONFIG_INVALID");
	return value;
}

function string(value: unknown): string {
	if (typeof value !== "string") throw new Error("FEATURE_CONFIG_INVALID");
	return value;
}

function parsePersistence(value: unknown): PersistenceCapabilities {
	if (value === undefined) return DISABLED_PERSISTENCE_CAPABILITIES;
	const source = record(value);
	exactKeys(source, [
		"favoritesEnabled",
		"historyEnabled",
		"privateFeedbackEnabled",
		"savedResourceIdsEnabled",
	]);
	return Object.freeze({
		favoritesEnabled: bool(source.favoritesEnabled),
		historyEnabled: bool(source.historyEnabled),
		privateFeedbackEnabled: bool(source.privateFeedbackEnabled),
		savedResourceIdsEnabled: bool(source.savedResourceIdsEnabled),
	});
}

function parseAuth(value: unknown): AuthCapabilities {
	if (value === undefined) return DISABLED_AUTH_CAPABILITIES;
	const source = record(value);
	exactKeys(source, [
		"accountsEnabled",
		"registrationEnabled",
		"phoneEnabled",
		"wechatEnabled",
		"emailEnabled",
		"qqEnabled",
		"dataExportEnabled",
	]);
	bool(source.wechatEnabled);
	bool(source.qqEnabled);
	return Object.freeze({
		accountsEnabled: bool(source.accountsEnabled),
		registrationEnabled: bool(source.registrationEnabled),
		phoneEnabled: bool(source.phoneEnabled),
		wechatEnabled: false,
		emailEnabled: bool(source.emailEnabled),
		// The API may advertise Android QQ, but this client never exposes it.
		qqEnabled: false,
		dataExportEnabled:
			source.dataExportEnabled === undefined
				? false
				: bool(source.dataExportEnabled),
	});
}

function parseServices(value: unknown): ServiceCapabilities {
	if (value === undefined) return DISABLED_SERVICE_CAPABILITIES;
	const source = record(value);
	exactKeys(source, [
		"recommendationsEnabled",
		"groupRecommendationsEnabled",
		"locationSearchEnabled",
		"placeSearchEnabled",
	]);
	if (
		source.groupRecommendationsEnabled !== undefined &&
		source.groupRecommendationsEnabled !== false
	)
		throw new Error("FEATURE_CONFIG_INVALID");
	if (source.placeSearchEnabled !== undefined) bool(source.placeSearchEnabled);
	return Object.freeze({
		groupRecommendationsEnabled: false,
		recommendationsEnabled:
			source.recommendationsEnabled === undefined
				? false
				: bool(source.recommendationsEnabled),
		locationSearchEnabled:
			source.locationSearchEnabled === undefined
				? false
				: bool(source.locationSearchEnabled),
		// Android 1.0 parity: direct restaurant search has no product entry.
		placeSearchEnabled: false,
	});
}

export function parseFeatureConfig(value: unknown): MiniProgramFeatureConfig {
	const source = record(value);
	exactKeys(source, [
		"coverageName",
		"dataRightsMode",
		"aiEnabled",
		"accountsEnabled",
		"favoritesEnabled",
		"supportFeedbackEnabled",
		"minimumSupportedVersion",
		"ruleVersion",
		"promptVersion",
		"modelVersion",
		"persistenceCapabilities",
		"authCapabilities",
		"serviceCapabilities",
		"recommendationDefaults",
		"minimumSupportedVersions",
		"operationalConfig",
		"rulesConfigVersion",
		"specialtyCapabilities",
	]);
	const rights = source.dataRightsMode;
	if (rights !== "LIVE_DISPLAY_ONLY" && rights !== "LICENSED_ENRICHMENT") {
		throw new Error("FEATURE_CONFIG_INVALID");
	}
	const persistence = parsePersistence(source.persistenceCapabilities);
	const accountsEnabled = bool(source.accountsEnabled);
	const favoritesEnabled = bool(source.favoritesEnabled);
	if (persistence.favoritesEnabled !== favoritesEnabled) {
		throw new Error("FEATURE_CONFIG_INVALID");
	}
	if (
		rights === "LIVE_DISPLAY_ONLY" &&
		Object.values(persistence).some(Boolean)
	) {
		throw new Error("FEATURE_CONFIG_INVALID");
	}
	const auth = parseAuth(source.authCapabilities);
	if (auth.accountsEnabled !== accountsEnabled) {
		throw new Error("FEATURE_CONFIG_INVALID");
	}
	const minimumSupportedVersion = semanticVersion(
		source.minimumSupportedVersion,
	);
	const minimumSupportedVersions = parseMinimumVersions(
		source.minimumSupportedVersions,
	);
	if (
		minimumSupportedVersions !== null &&
		minimumSupportedVersions.android !== minimumSupportedVersion
	)
		throw new Error("FEATURE_CONFIG_INVALID");
	if (source.operationalConfig !== undefined)
		validateOperationalConfig(source.operationalConfig);
	return Object.freeze({
		recommendationDefaults: parseRecommendationDefaults(
			source.recommendationDefaults,
		),
		minimumSupportedVersions,
		specialtyCapabilities: parseSpecialtyCapabilities(
			source.specialtyCapabilities,
		),
		rulesConfigVersion: optionalVersionNumber(source.rulesConfigVersion),
		coverageName: string(source.coverageName),
		dataRightsMode: rights,
		aiEnabled: bool(source.aiEnabled),
		accountsEnabled,
		favoritesEnabled,
		supportFeedbackEnabled:
			source.supportFeedbackEnabled === undefined
				? false
				: bool(source.supportFeedbackEnabled),
		minimumSupportedVersion,
		ruleVersion: string(source.ruleVersion),
		promptVersion: string(source.promptVersion),
		modelVersion: string(source.modelVersion),
		persistenceCapabilities: persistence,
		authCapabilities: auth,
		serviceCapabilities: parseServices(source.serviceCapabilities),
	});
}

function semanticVersion(value: unknown): string {
	const parsed = string(value);
	if (
		!/^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/u.test(
			parsed,
		)
	)
		throw new Error("FEATURE_CONFIG_INVALID");
	return parsed;
}

function integer(value: unknown, minimum: number, maximum: number): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new Error("FEATURE_CONFIG_INVALID");
	return value;
}

function optionalVersionNumber(value: unknown): number | null {
	return value === null || value === undefined
		? null
		: integer(value, 1, Number.MAX_SAFE_INTEGER);
}

function parseRecommendationDefaults(
	value: unknown,
): PublicRecommendationDefaults | null {
	if (value === undefined) return null;
	const source = record(value);
	exactKeys(source, ["areaCode", "defaultRadiusMeters", "maximumRadiusMeters"]);
	if (source.areaCode !== "NATIONWIDE")
		throw new Error("FEATURE_CONFIG_INVALID");
	const defaultRadiusMeters = integer(source.defaultRadiusMeters, 200, 10_000);
	const maximumRadiusMeters = integer(source.maximumRadiusMeters, 200, 10_000);
	if (defaultRadiusMeters > maximumRadiusMeters)
		throw new Error("FEATURE_CONFIG_INVALID");
	return Object.freeze({
		areaCode: "NATIONWIDE",
		defaultRadiusMeters,
		maximumRadiusMeters,
	});
}

function parseMinimumVersions(
	value: unknown,
): PublicMinimumSupportedVersions | null {
	if (value === undefined) return null;
	const source = record(value);
	exactKeys(source, ["android", "ios", "miniprogram"]);
	return Object.freeze({
		android: semanticVersion(source.android),
		...(source.ios === undefined ? {} : { ios: semanticVersion(source.ios) }),
		...(source.miniprogram === undefined
			? {}
			: { miniprogram: semanticVersion(source.miniprogram) }),
	});
}

function parseSpecialtyCapabilities(value: unknown): SpecialtyCapabilities {
	if (value === undefined) return DISABLED_SPECIALTY_CAPABILITIES;
	const source = record(value);
	exactKeys(source, Object.keys(DISABLED_SPECIALTY_CAPABILITIES));
	return Object.freeze({
		breakfastProfileEnabled: bool(source.breakfastProfileEnabled),
		dinnerProfileEnabled: bool(source.dinnerProfileEnabled),
		milkTeaEnabled: bool(source.milkTeaEnabled),
		coffeeEnabled: bool(source.coffeeEnabled),
		dessertEnabled: bool(source.dessertEnabled),
		userReportedWeatherEnabled: bool(source.userReportedWeatherEnabled),
	});
}

function validateOperationalConfig(value: unknown): void {
	const source = record(value);
	exactKeys(source, [
		"source",
		"lastSuccessfulReadAt",
		"cacheTtlMs",
		"versions",
		"aiStatus",
	]);
	if (
		!["STARTUP_DEFAULT", "DATABASE", "STALE_CACHE", "SAFE_FALLBACK"].includes(
			string(source.source),
		) ||
		source.cacheTtlMs !== 5_000
	)
		throw new Error("FEATURE_CONFIG_INVALID");
	if (
		![
			"ENABLED",
			"SERVER_DISABLED",
			"OPERATOR_DISABLED",
			"PROMPT_DISABLED",
			"CONFIG_UNAVAILABLE",
		].includes(string(source.aiStatus))
	)
		throw new Error("FEATURE_CONFIG_INVALID");
	if (source.lastSuccessfulReadAt !== null) {
		const timestamp = string(source.lastSuccessfulReadAt);
		if (
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(timestamp) ||
			Number.isNaN(Date.parse(timestamp))
		)
			throw new Error("FEATURE_CONFIG_INVALID");
	}
	const versions = record(source.versions);
	const keys = [
		"features.ai-assistance",
		"recommendations.rules",
		"recommendations.prompt",
		"coverage.default",
		"clients.minimum-version",
	];
	exactKeys(versions, keys);
	for (const key of keys) {
		if (versions[key] === undefined) throw new Error("FEATURE_CONFIG_INVALID");
		optionalVersionNumber(versions[key]);
	}
}

export interface FeatureConfigSource {
	loadFeatureConfig(): Promise<unknown>;
}

export type FeatureConfigState =
	| Readonly<{ kind: "READY"; config: MiniProgramFeatureConfig }>
	| Readonly<{ kind: "UNAVAILABLE" }>;

export class FeatureConfigService {
	private state: FeatureConfigState = Object.freeze({ kind: "UNAVAILABLE" });
	private revision = 0;

	constructor(private readonly source: FeatureConfigSource) {}

	current(): FeatureConfigState {
		return this.state;
	}

	revoke(): void {
		this.revision += 1;
		this.state = Object.freeze({ kind: "UNAVAILABLE" });
	}

	async refresh(): Promise<FeatureConfigState> {
		const revision = ++this.revision;
		let next: FeatureConfigState;
		try {
			const config = parseFeatureConfig(await this.source.loadFeatureConfig());
			next = Object.freeze({ kind: "READY", config });
		} catch {
			next = Object.freeze({ kind: "UNAVAILABLE" });
		}
		if (revision !== this.revision) return this.state;
		this.state = next;
		return this.state;
	}
}
