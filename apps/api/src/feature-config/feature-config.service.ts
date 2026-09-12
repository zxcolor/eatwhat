import {
	type DataRightsMode,
	DISABLED_SPECIALTY_CAPABILITIES,
	type FeatureConfig,
	FeatureConfigSchema,
	type MealPeriod,
	type RecommendationTarget,
	type SpecialtyCapabilities,
	type WeatherContextRequest,
} from "@chi-shen-me/contracts";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { DataRightsPolicy } from "../config/data-rights-policy.js";
import {
	LOCATION_SEARCH_PROVIDER,
	type LocationSearchProvider,
} from "../location-search/location-search.provider.js";
import { OperationalConfigService, OPERATIONAL_CONFIG_CACHE_TTL_MS } from "../operational-config/operational-config.service.js";
import { isOperationalConfigAvailable, startupOperationalConfig } from "../operational-config/operational-config.types.js";
import {
	PLACE_KEYWORD_SEARCH_PROVIDER,
	type PlaceKeywordSearchProvider,
} from "../place-search/place-keyword-search.provider.js";
import {
	PLACE_PROVIDER,
	type PlaceProvider,
} from "../recommendations/domain/place-candidate.js";
import { buildRecommendationQueryPlan } from "../recommendations/domain/recommendation-query-plan.js";
import { SupportFeedbackService } from "../support-feedback/support-feedback.service.js";

type ProfileCapabilityProbe = Readonly<{
	target: RecommendationTarget;
	mealPeriod: MealPeriod;
}>;

const BREAKFAST_PROFILE_PROBE = Object.freeze({
	target: "MEAL" as const,
	mealPeriod: "BREAKFAST" as const,
});
const DEFAULT_RECOMMENDATION_PROBE = Object.freeze({
	target: "MEAL" as const,
	mealPeriod: "LUNCH" as const,
});
const DINNER_PROFILE_PROBE = Object.freeze({
	target: "MEAL" as const,
	mealPeriod: "DINNER" as const,
});
const MILK_TEA_PROFILE_PROBE = Object.freeze({
	target: "MILK_TEA" as const,
	mealPeriod: "LUNCH" as const,
});
const COFFEE_PROFILE_PROBE = Object.freeze({
	target: "COFFEE" as const,
	mealPeriod: "LUNCH" as const,
});
const DESSERT_PROFILE_PROBE = Object.freeze({
	target: "DESSERT" as const,
	mealPeriod: "LUNCH" as const,
});

const PROFILE_CAPABILITY_PROBES: readonly ProfileCapabilityProbe[] =
	Object.freeze([
		BREAKFAST_PROFILE_PROBE,
		DEFAULT_RECOMMENDATION_PROBE,
		DINNER_PROFILE_PROBE,
		MILK_TEA_PROFILE_PROBE,
		COFFEE_PROFILE_PROBE,
		DESSERT_PROFILE_PROBE,
	]);

const USER_REPORTED_WEATHER_PROBES: readonly WeatherContextRequest[] =
	Object.freeze([
		Object.freeze({
			kind: "USER_REPORTED" as const,
			preference: "MINIMIZE_EXPOSURE" as const,
		}),
		Object.freeze({
			kind: "USER_REPORTED" as const,
			preference: "WARMING" as const,
		}),
		Object.freeze({
			kind: "USER_REPORTED" as const,
			preference: "COOLING" as const,
		}),
	]);

const NO_WEATHER = Object.freeze({ kind: "NONE" as const });

@Injectable()
export class FeatureConfigService {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(PLACE_PROVIDER) private readonly places: PlaceProvider,
		@Inject(LOCATION_SEARCH_PROVIDER)
		private readonly locationSearch: LocationSearchProvider,
		@Inject(PLACE_KEYWORD_SEARCH_PROVIDER)
		private readonly placeSearch: PlaceKeywordSearchProvider,
		private readonly dataRightsPolicy: DataRightsPolicy,
		private readonly supportFeedback: SupportFeedbackService,
		@Optional()
		private readonly operationalConfig?: OperationalConfigService,
	) {}

	private supportsProfile(
		probe: ProfileCapabilityProbe,
		weatherContext: WeatherContextRequest = NO_WEATHER,
	): boolean {
		try {
			return this.places.supportsQueryPlan(
				buildRecommendationQueryPlan({
					target: probe.target,
					mealPeriod: probe.mealPeriod,
					preferredCuisines: [],
					weatherContext,
				}),
			);
		} catch {
			// Capability discovery is a security boundary. An adapter that cannot
			// answer for a concrete immutable plan must not enable that UI path.
			return false;
		}
	}

	private specialtyCapabilities(
		recommendationsEnabled: boolean,
	): Readonly<SpecialtyCapabilities> {
		if (!recommendationsEnabled) return DISABLED_SPECIALTY_CAPABILITIES;
		return Object.freeze({
			breakfastProfileEnabled: this.supportsProfile(BREAKFAST_PROFILE_PROBE),
			dinnerProfileEnabled: this.supportsProfile(DINNER_PROFILE_PROBE),
			milkTeaEnabled: this.supportsProfile(MILK_TEA_PROFILE_PROBE),
			coffeeEnabled: this.supportsProfile(COFFEE_PROFILE_PROBE),
			dessertEnabled: this.supportsProfile(DESSERT_PROFILE_PROBE),
			// This is one global switch, so every currently selectable profile and
			// every bounded user-reported preference must be supported. Partial
			// weather support stays hidden rather than failing after selection.
			userReportedWeatherEnabled: PROFILE_CAPABILITY_PROBES.every((probe) =>
				USER_REPORTED_WEATHER_PROBES.every((weather) =>
					this.supportsProfile(probe, weather),
				),
			),
		});
	}

	async getPublicConfig(): Promise<FeatureConfig> {
		const operational =
			(await this.operationalConfig?.current()) ??
			startupOperationalConfig(this.config);
		let effectiveDataRightsMode: DataRightsMode = "LIVE_DISPLAY_ONLY";
		let canPersistPlaceReference = false;
		try {
			[effectiveDataRightsMode, canPersistPlaceReference] = await Promise.all([
				this.dataRightsPolicy.effectiveMode(this.places.kind),
				this.dataRightsPolicy.canPersistPlaceReference(this.places.kind),
			]);
		} catch {
			// Public capability discovery is fail-closed. A policy/database outage
			// must never advertise a write path that the runtime cannot authorize.
			effectiveDataRightsMode = "LIVE_DISPLAY_ONLY";
			canPersistPlaceReference = false;
		}
		const persistenceRightsReady =
			this.config.features.accountsEnabled &&
			effectiveDataRightsMode === "LICENSED_ENRICHMENT" &&
			canPersistPlaceReference;
		const favoritesEnabled =
			persistenceRightsReady && this.config.features.favoritesEnabled;
		const historyEnabled =
			persistenceRightsReady && this.config.features.historyEnabled;
		const privateFeedbackEnabled =
			persistenceRightsReady && this.config.features.privateFeedbackEnabled;
		const persistenceCapabilities = Object.freeze({
			favoritesEnabled,
			historyEnabled,
			privateFeedbackEnabled,
			savedResourceIdsEnabled:
				favoritesEnabled || historyEnabled || privateFeedbackEnabled,
		});
		let supportFeedbackEnabled = false;
		try {
			supportFeedbackEnabled = this.supportFeedback.isReady();
		} catch {
			// Readiness is an authorization boundary, not merely display metadata.
			// An unexpected readiness failure must therefore remain fail-closed.
			supportFeedbackEnabled = false;
		}
		const recommendationsEnabled =
			isOperationalConfigAvailable(operational) &&
			this.places.kind !== "UNAVAILABLE" &&
			this.supportsProfile(DEFAULT_RECOMMENDATION_PROBE);
		const aiStatus = !isOperationalConfigAvailable(operational)
			? "CONFIG_UNAVAILABLE"
			: !this.config.qwen.enabled
				? "SERVER_DISABLED"
				: !operational.aiAssistanceEnabled
					? "OPERATOR_DISABLED"
					: !operational.prompt.enabled
						? "PROMPT_DISABLED"
						: "ENABLED";
		const aiEnabled = aiStatus === "ENABLED";
		return FeatureConfigSchema.parse({
			coverageName:
				operational.coverage.areaCode === "NATIONWIDE"
					? "全国范围"
					: operational.coverage.areaCode,
			dataRightsMode: effectiveDataRightsMode,
			aiEnabled,
			accountsEnabled: this.config.features.accountsEnabled,
			favoritesEnabled,
			supportFeedbackEnabled,
			persistenceCapabilities,
			minimumSupportedVersion: operational.minimumAppVersions.android,
			recommendationDefaults: {
				areaCode: operational.coverage.areaCode,
				defaultRadiusMeters: operational.coverage.defaultRadiusMeters,
				maximumRadiusMeters: operational.coverage.maximumRadiusMeters,
			},
			minimumSupportedVersions: operational.minimumAppVersions,
			ruleVersion: this.config.versions.rule,
			rulesConfigVersion: operational.versions["recommendations.rules"],
			promptVersion: operational.prompt.promptVersion,
			modelVersion:
				aiEnabled
					? operational.prompt.modelVersion
					: this.config.versions.ruleFallbackModel,
			serviceCapabilities: {
				recommendationsEnabled,
				groupRecommendationsEnabled: false,
				locationSearchEnabled: this.locationSearch.dataSource !== "UNAVAILABLE",
				placeSearchEnabled: this.placeSearch.dataSource !== "UNAVAILABLE",
			},
			specialtyCapabilities: this.specialtyCapabilities(recommendationsEnabled),
			operationalConfig: {
				source: operational.source,
				lastSuccessfulReadAt: operational.lastSuccessfulReadAt,
				cacheTtlMs: OPERATIONAL_CONFIG_CACHE_TTL_MS,
				versions: operational.versions,
				aiStatus,
			},
			authCapabilities: {
				accountsEnabled: this.config.auth.enabled,
				registrationEnabled: this.config.auth.registrationEnabled,
				phoneEnabled:
					this.config.auth.enabled && this.config.auth.phone.enabled,
				wechatEnabled:
					this.config.auth.enabled && this.config.auth.wechat.enabled,
				emailEnabled:
					this.config.auth.enabled && this.config.auth.email.enabled,
				qqEnabled: this.config.auth.enabled && this.config.auth.qq.enabled,
				dataExportEnabled:
					this.config.auth.enabled &&
					this.config.auth.dataExportEnabled &&
					this.config.dataExportArtifacts.enabled &&
					this.config.dataExportWorkerReady === true,
			},
		});
	}
}
