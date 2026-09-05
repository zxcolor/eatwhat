import { describe, expect, it, vi } from "vitest";
import { type AppConfig, loadAppConfig } from "../config/app-config.js";
import type { DataRightsPolicy } from "../config/data-rights-policy.js";
import type { LocationSearchProvider } from "../location-search/location-search.provider.js";
import type { PlaceKeywordSearchProvider } from "../place-search/place-keyword-search.provider.js";
import type { PlaceProvider } from "../recommendations/domain/place-candidate.js";
import type { RecommendationQueryPlan } from "../recommendations/domain/recommendation-query-plan.js";
import type { SupportFeedbackService } from "../support-feedback/support-feedback.service.js";
import { FeatureConfigService } from "./feature-config.service.js";

const placeProvider = {
	kind: "AMAP",
	dataMode: "LIVE",
	supportsQueryPlan: (plan: RecommendationQueryPlan) =>
		plan.profile.target === "MEAL" && plan.weatherApplication.kind === "NONE",
} as PlaceProvider;
const locationSearchProvider = {
	dataSource: "AMAP",
	dataMode: "LIVE",
} as LocationSearchProvider;
const placeSearchProvider = {
	dataSource: "AMAP",
	dataMode: "LIVE",
} as PlaceKeywordSearchProvider;

function config(input?: {
	groupRecommendations?: boolean;
	accounts?: boolean;
	favorites?: boolean;
	history?: boolean;
	privateFeedback?: boolean;
	dataExport?: boolean;
	phone?: boolean;
	wechat?: boolean;
}): AppConfig {
	const base = loadAppConfig({ NODE_ENV: "test" });
	const accountsEnabled = input?.accounts ?? true;
	const dataExportEnabled = input?.dataExport ?? false;
	const phoneEnabled = input?.phone ?? false;
	const wechatEnabled = input?.wechat ?? false;
	return Object.freeze({
		...base,
		dataExportWorkerReady: dataExportEnabled,
		auth: Object.freeze({
			...base.auth,
			enabled: accountsEnabled,
			registrationEnabled: accountsEnabled && phoneEnabled,
			dataExportEnabled,
			phone: Object.freeze({
				...base.auth.phone,
				enabled: phoneEnabled,
			}),
			wechat: Object.freeze({
				...base.auth.wechat,
				enabled: wechatEnabled,
			}),
		}),
		dataExportArtifacts: Object.freeze({
			...base.dataExportArtifacts,
			enabled: dataExportEnabled,
		}),
		features: Object.freeze({
			...base.features,
			groupRecommendationsEnabled: input?.groupRecommendations ?? false,
			accountsEnabled,
			favoritesEnabled: input?.favorites ?? false,
			historyEnabled: input?.history ?? false,
			privateFeedbackEnabled: input?.privateFeedback ?? false,
		}),
	});
}

function policy(input?: {
	mode?: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
	persist?: boolean;
	failure?: Error;
}): DataRightsPolicy {
	return {
		effectiveMode: vi.fn(async () => {
			if (input?.failure !== undefined) throw input.failure;
			return input?.mode ?? "LICENSED_ENRICHMENT";
		}),
		canPersistPlaceReference: vi.fn(async () => {
			if (input?.failure !== undefined) throw input.failure;
			return input?.persist ?? true;
		}),
	} as unknown as DataRightsPolicy;
}

function supportFeedback(
	ready = false,
	failure?: Error,
): SupportFeedbackService {
	return {
		isReady: () => {
			if (failure !== undefined) throw failure;
			return ready;
		},
	} as unknown as SupportFeedbackService;
}

describe("FeatureConfigService persistence capabilities", () => {
	it("always returns the complete fail-closed capability object", async () => {
		const service = new FeatureConfigService(
			config({
				accounts: false,
				favorites: true,
				history: true,
				privateFeedback: true,
			}),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		await expect(service.getPublicConfig()).resolves.toMatchObject({
			favoritesEnabled: false,
			serviceCapabilities: {
				groupRecommendationsEnabled: false,
			},
			persistenceCapabilities: {
				favoritesEnabled: false,
				historyEnabled: false,
				privateFeedbackEnabled: false,
				savedResourceIdsEnabled: false,
			},
			specialtyCapabilities: {
				breakfastProfileEnabled: true,
				dinnerProfileEnabled: true,
				milkTeaEnabled: false,
				coffeeEnabled: false,
				dessertEnabled: false,
				userReportedWeatherEnabled: false,
			},
		});
	});

	it("derives specialty capabilities only from concrete query-plan support", async () => {
		const fullyCapableProvider = {
			kind: "AUTHORIZED_VENDOR",
			dataMode: "LIVE",
			supportsQueryPlan: vi.fn(() => true),
		} as unknown as PlaceProvider;
		const service = new FeatureConfigService(
			config(),
			fullyCapableProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		await expect(service.getPublicConfig()).resolves.toMatchObject({
			specialtyCapabilities: {
				breakfastProfileEnabled: true,
				dinnerProfileEnabled: true,
				milkTeaEnabled: true,
				coffeeEnabled: true,
				dessertEnabled: true,
				userReportedWeatherEnabled: true,
			},
		});
		expect(fullyCapableProvider.supportsQueryPlan).toHaveBeenCalled();
	});

	it("advertises group recommendations only behind both the switch and concrete core plan support", async () => {
		const disabledByDefault = new FeatureConfigService(
			config(),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);
		await expect(disabledByDefault.getPublicConfig()).resolves.toMatchObject({
			serviceCapabilities: { groupRecommendationsEnabled: false },
		});

		const enabled = new FeatureConfigService(
			config({ groupRecommendations: true }),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);
		await expect(enabled.getPublicConfig()).resolves.toMatchObject({
			serviceCapabilities: {
				recommendationsEnabled: true,
				groupRecommendationsEnabled: true,
			},
		});

		const unsupportedProvider = {
			kind: "AUTHORIZED_VENDOR",
			dataMode: "LIVE",
			supportsQueryPlan: vi.fn(() => false),
		} as unknown as PlaceProvider;
		const unsupported = new FeatureConfigService(
			config({ groupRecommendations: true }),
			unsupportedProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);
		await expect(unsupported.getPublicConfig()).resolves.toMatchObject({
			serviceCapabilities: {
				recommendationsEnabled: false,
				groupRecommendationsEnabled: false,
			},
		});

		let capabilityProbeCount = 0;
		const independentlyFailingProvider = {
			kind: "AUTHORIZED_VENDOR",
			dataMode: "LIVE",
			supportsQueryPlan: vi.fn(() => {
				capabilityProbeCount += 1;
				if (capabilityProbeCount === 1) return true;
				throw new Error("private second probe failure");
			}),
		} as unknown as PlaceProvider;
		const independentlyFailed = new FeatureConfigService(
			config({ groupRecommendations: true }),
			independentlyFailingProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);
		const independentlyFailedResult =
			await independentlyFailed.getPublicConfig();
		expect(independentlyFailedResult.serviceCapabilities).toMatchObject({
			recommendationsEnabled: true,
			groupRecommendationsEnabled: false,
		});
		expect(JSON.stringify(independentlyFailedResult)).not.toContain(
			"private second probe failure",
		);
	});

	it("fails adapter capability errors closed without exposing the failure", async () => {
		const failingProvider = {
			kind: "DEMO",
			dataMode: "DEMO",
			supportsQueryPlan: vi.fn(() => {
				throw new Error("private capability failure");
			}),
		} as unknown as PlaceProvider;
		const service = new FeatureConfigService(
			config(),
			failingProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		const result = await service.getPublicConfig();
		expect(result.serviceCapabilities.recommendationsEnabled).toBe(false);
		expect(result.specialtyCapabilities).toEqual({
			breakfastProfileEnabled: false,
			dinnerProfileEnabled: false,
			milkTeaEnabled: false,
			coffeeEnabled: false,
			dessertEnabled: false,
			userReportedWeatherEnabled: false,
		});
		expect(JSON.stringify(result)).not.toContain("private capability failure");
	});

	it("keeps an unavailable adapter closed even when it understands meal plans", async () => {
		const unavailableProvider = {
			kind: "UNAVAILABLE",
			dataMode: "LIVE",
			supportsQueryPlan: vi.fn(() => true),
		} as unknown as PlaceProvider;
		const service = new FeatureConfigService(
			config(),
			unavailableProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		const result = await service.getPublicConfig();
		expect(result.serviceCapabilities.recommendationsEnabled).toBe(false);
		expect(result.specialtyCapabilities).toEqual({
			breakfastProfileEnabled: false,
			dinnerProfileEnabled: false,
			milkTeaEnabled: false,
			coffeeEnabled: false,
			dessertEnabled: false,
			userReportedWeatherEnabled: false,
		});
		expect(unavailableProvider.supportsQueryPlan).not.toHaveBeenCalled();
	});

	it("advertises only individually deployed and licensed capabilities", async () => {
		const service = new FeatureConfigService(
			config({ accounts: true, history: true }),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		await expect(service.getPublicConfig()).resolves.toMatchObject({
			dataRightsMode: "LICENSED_ENRICHMENT",
			favoritesEnabled: false,
			persistenceCapabilities: {
				favoritesEnabled: false,
				historyEnabled: true,
				privateFeedbackEnabled: false,
				savedResourceIdsEnabled: true,
			},
		});
	});

	it("keeps the compatibility favorite field identical to the nested field", async () => {
		const service = new FeatureConfigService(
			config({ accounts: true, favorites: true }),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		const result = await service.getPublicConfig();
		expect(result.favoritesEnabled).toBe(true);
		expect(result.persistenceCapabilities?.favoritesEnabled).toBe(
			result.favoritesEnabled,
		);
	});

	it("advertises data export only when accounts, the API reader and worker deployment are enabled", async () => {
		const ready = new FeatureConfigService(
			config({ accounts: true, dataExport: true }),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);
		await expect(ready.getPublicConfig()).resolves.toMatchObject({
			authCapabilities: { dataExportEnabled: true },
		});

		const notReadyConfig = config({ accounts: true, dataExport: true });
		const notReady = new FeatureConfigService(
			Object.freeze({
				...notReadyConfig,
				dataExportWorkerReady: false,
			}),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);
		await expect(notReady.getPublicConfig()).resolves.toMatchObject({
			authCapabilities: { dataExportEnabled: false },
		});
	});

	it("advertises phone registration without requiring a social provider", async () => {
		const service = new FeatureConfigService(
			config({ accounts: true, phone: true, wechat: false }),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		await expect(service.getPublicConfig()).resolves.toMatchObject({
			authCapabilities: {
				accountsEnabled: true,
				registrationEnabled: true,
				phoneEnabled: true,
				wechatEnabled: false,
			},
		});
	});

	it("keeps registration closed when the phone channel is disabled", async () => {
		const service = new FeatureConfigService(
			config({ accounts: true, phone: false, wechat: true }),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(),
		);

		await expect(service.getPublicConfig()).resolves.toMatchObject({
			authCapabilities: {
				accountsEnabled: true,
				registrationEnabled: false,
				phoneEnabled: false,
				wechatEnabled: true,
			},
		});
	});

	it("advertises support feedback only from the verified runtime readiness gate", async () => {
		const ready = new FeatureConfigService(
			config(),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(true),
		);
		await expect(ready.getPublicConfig()).resolves.toMatchObject({
			supportFeedbackEnabled: true,
		});

		const notReady = new FeatureConfigService(
			config(),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(false),
		);
		await expect(notReady.getPublicConfig()).resolves.toMatchObject({
			supportFeedbackEnabled: false,
		});

		const failedReadiness = new FeatureConfigService(
			config(),
			placeProvider,
			locationSearchProvider,
			placeSearchProvider,
			policy(),
			supportFeedback(false, new Error("private readiness failure")),
		);
		const failedResult = await failedReadiness.getPublicConfig();
		expect(failedResult.supportFeedbackEnabled).toBe(false);
		expect(JSON.stringify(failedResult)).not.toContain(
			"private readiness failure",
		);
	});

	it("advertises only the three actually selected provider capabilities", async () => {
		const unavailableLocation = {
			dataSource: "UNAVAILABLE",
			dataMode: "LIVE",
		} as LocationSearchProvider;
		const unavailablePlaceSearch = {
			dataSource: "UNAVAILABLE",
			dataMode: "LIVE",
		} as PlaceKeywordSearchProvider;
		const service = new FeatureConfigService(
			config(),
			placeProvider,
			unavailableLocation,
			unavailablePlaceSearch,
			policy(),
			supportFeedback(),
		);

		await expect(service.getPublicConfig()).resolves.toMatchObject({
			serviceCapabilities: {
				recommendationsEnabled: true,
				locationSearchEnabled: false,
				placeSearchEnabled: false,
			},
		});
	});

	it.each([
		[
			"live-only mode",
			policy({ mode: "LIVE_DISPLAY_ONLY", persist: true }),
			"LIVE_DISPLAY_ONLY",
		],
		[
			"missing persistence grant",
			policy({ persist: false }),
			"LICENSED_ENRICHMENT",
		],
		[
			"database or policy failure",
			policy({ failure: new Error("private DB error") }),
			"LIVE_DISPLAY_ONLY",
		],
	] as const)(
		"fails every capability closed for %s",
		async (_name, rights, expectedMode) => {
			const service = new FeatureConfigService(
				config({
					accounts: true,
					favorites: true,
					history: true,
					privateFeedback: true,
				}),
				placeProvider,
				locationSearchProvider,
				placeSearchProvider,
				rights,
				supportFeedback(),
			);

			const result = await service.getPublicConfig();
			expect(result.dataRightsMode).toBe(expectedMode);
			expect(result.favoritesEnabled).toBe(false);
			expect(result.persistenceCapabilities).toEqual({
				favoritesEnabled: false,
				historyEnabled: false,
				privateFeedbackEnabled: false,
				savedResourceIdsEnabled: false,
			});
			expect(JSON.stringify(result)).not.toContain("private DB error");
		},
	);
});
