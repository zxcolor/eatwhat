import {
	type DataRightsMode,
	type FeatureConfig,
	FeatureConfigSchema,
} from "@chi-shen-me/contracts";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { DataRightsPolicy } from "../config/data-rights-policy.js";
import {
	LOCATION_SEARCH_PROVIDER,
	type LocationSearchProvider,
} from "../location-search/location-search.provider.js";
import { OperationalConfigService } from "../operational-config/operational-config.service.js";
import { startupOperationalConfig } from "../operational-config/operational-config.types.js";
import {
	PLACE_KEYWORD_SEARCH_PROVIDER,
	type PlaceKeywordSearchProvider,
} from "../place-search/place-keyword-search.provider.js";
import {
	PLACE_PROVIDER,
	type PlaceProvider,
} from "../recommendations/domain/place-candidate.js";
import { SupportFeedbackService } from "../support-feedback/support-feedback.service.js";

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
		return FeatureConfigSchema.parse({
			coverageName:
				operational.coverage.areaCode === "NATIONWIDE"
					? "全国范围"
					: operational.coverage.areaCode,
			dataRightsMode: effectiveDataRightsMode,
			aiEnabled:
				this.config.qwen.enabled &&
				operational.aiAssistanceEnabled &&
				operational.prompt.enabled,
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
			ruleVersion:
				operational.versions["recommendations.rules"] === null
					? this.config.versions.rule
					: `recommendation-rules-v${operational.versions["recommendations.rules"]}`,
			promptVersion: operational.prompt.promptVersion,
			modelVersion:
				this.config.qwen.enabled &&
				operational.aiAssistanceEnabled &&
				operational.prompt.enabled
					? operational.prompt.modelVersion
					: this.config.versions.ruleFallbackModel,
			serviceCapabilities: {
				recommendationsEnabled: this.places.kind !== "UNAVAILABLE",
				locationSearchEnabled: this.locationSearch.dataSource !== "UNAVAILABLE",
				placeSearchEnabled: this.placeSearch.dataSource !== "UNAVAILABLE",
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
