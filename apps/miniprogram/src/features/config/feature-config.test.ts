import { describe, expect, it } from "vitest";
import { FeatureConfigSchema } from "../../../../../packages/contracts/src/index";
import { FeatureConfigService, parseFeatureConfig } from "./feature-config";

const base = {
	coverageName: "全国",
	dataRightsMode: "LIVE_DISPLAY_ONLY",
	aiEnabled: false,
	accountsEnabled: true,
	favoritesEnabled: false,
	supportFeedbackEnabled: true,
	minimumSupportedVersion: "0.1.0",
	ruleVersion: "rules-v1",
	promptVersion: "prompt-v1",
	modelVersion: "none",
	persistenceCapabilities: {
		favoritesEnabled: false,
		historyEnabled: false,
		privateFeedbackEnabled: false,
		savedResourceIdsEnabled: false,
	},
	authCapabilities: {
		accountsEnabled: true,
		registrationEnabled: true,
		phoneEnabled: true,
		wechatEnabled: true,
		emailEnabled: true,
		qqEnabled: true,
		dataExportEnabled: true,
	},
	serviceCapabilities: {
		recommendationsEnabled: true,
		locationSearchEnabled: true,
		placeSearchEnabled: true,
	},
} as const;

describe("parseFeatureConfig", () => {
	it("accepts current shared configuration and independently projects mini-program versions", () => {
		const current = FeatureConfigSchema.parse({
			...base,
			minimumSupportedVersions: { android: "0.1.0", miniprogram: "0.2.0" },
			recommendationDefaults: {
				areaCode: "NATIONWIDE",
				defaultRadiusMeters: 700,
				maximumRadiusMeters: 1_000,
			},
			rulesConfigVersion: 5,
			specialtyCapabilities: {
				breakfastProfileEnabled: true,
				dinnerProfileEnabled: false,
				milkTeaEnabled: false,
				coffeeEnabled: true,
				dessertEnabled: false,
				userReportedWeatherEnabled: true,
			},
			operationalConfig: {
				source: "DATABASE",
				lastSuccessfulReadAt: "2026-09-17T00:00:00.000Z",
				cacheTtlMs: 5_000,
				versions: {
					"features.ai-assistance": 1,
					"recommendations.rules": 2,
					"recommendations.prompt": 3,
					"coverage.default": 4,
					"clients.minimum-version": 5,
				},
				aiStatus: "SERVER_DISABLED",
			},
		});
		const parsed = parseFeatureConfig(current);
		expect(parsed.minimumSupportedVersions?.miniprogram).toBe("0.2.0");
		expect(parsed.recommendationDefaults?.defaultRadiusMeters).toBe(700);
		expect(parsed.specialtyCapabilities.coffeeEnabled).toBe(true);
		expect(parsed.serviceCapabilities.groupRecommendationsEnabled).toBe(false);
		expect(parsed.authCapabilities.wechatEnabled).toBe(false);
	});

	it("fails closed for partial capabilities, invalid defaults, grouped dining and inconsistent versions", () => {
		for (const patch of [
			{ specialtyCapabilities: { coffeeEnabled: true } },
			{
				serviceCapabilities: {
					...base.serviceCapabilities,
					groupRecommendationsEnabled: true,
				},
			},
			{
				recommendationDefaults: {
					areaCode: "NATIONWIDE",
					defaultRadiusMeters: 2_000,
					maximumRadiusMeters: 1_000,
				},
			},
			{ minimumSupportedVersions: { android: "2.0.0", miniprogram: "0.1.0" } },
			{ rulesConfigVersion: 0 },
			{ operationalConfig: { source: "DATABASE" } },
		])
			expect(() => parseFeatureConfig({ ...base, ...patch })).toThrow(
				"FEATURE_CONFIG_INVALID",
			);
		expect(parseFeatureConfig(base).specialtyCapabilities.coffeeEnabled).toBe(
			false,
		);
		expect(parseFeatureConfig(base).minimumSupportedVersions).toBeNull();
	});

	it("prevents a slower earlier refresh from replacing newer capabilities", async () => {
		let completeFirst: (value: unknown) => void = () => undefined;
		let call = 0;
		const service = new FeatureConfigService({
			loadFeatureConfig: () =>
				++call === 1
					? new Promise((resolve) => {
							completeFirst = resolve;
						})
					: Promise.resolve({ ...base, supportFeedbackEnabled: false }),
		});
		const old = service.refresh();
		await service.refresh();
		completeFirst(base);
		await old;
		expect(service.current()).toMatchObject({
			kind: "READY",
			config: { supportFeedbackEnabled: false },
		});
	});
	it("closes QQ and direct restaurant search at the mini-program product boundary", () => {
		const parsed = parseFeatureConfig(base);
		expect(parsed.authCapabilities.qqEnabled).toBe(false);
		expect(parsed.serviceCapabilities.placeSearchEnabled).toBe(false);
		expect(parsed.serviceCapabilities.recommendationsEnabled).toBe(true);
	});

	it("rejects persistence in live-display-only mode", () => {
		expect(() =>
			parseFeatureConfig({
				...base,
				favoritesEnabled: true,
				persistenceCapabilities: {
					...base.persistenceCapabilities,
					favoritesEnabled: true,
				},
			}),
		).toThrow("FEATURE_CONFIG_INVALID");
	});

	it("fails closed when refresh data is malformed", async () => {
		const service = new FeatureConfigService({
			loadFeatureConfig: async () => ({ ...base, unknown: true }),
		});
		await expect(service.refresh()).resolves.toEqual({ kind: "UNAVAILABLE" });
	});

	it("does not restore a late configuration after authority is revoked", async () => {
		let resolveLoad: (value: unknown) => void = () => undefined;
		const pending = new Promise<unknown>((resolve) => {
			resolveLoad = resolve;
		});
		const service = new FeatureConfigService({
			loadFeatureConfig: () => pending,
		});
		const refresh = service.refresh();

		service.revoke();
		resolveLoad(base);

		await expect(refresh).resolves.toEqual({ kind: "UNAVAILABLE" });
		expect(service.current()).toEqual({ kind: "UNAVAILABLE" });
	});
});
