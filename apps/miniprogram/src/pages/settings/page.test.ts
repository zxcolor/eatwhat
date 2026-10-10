import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

async function setup(mode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT") {
	vi.resetModules();
	const { createDecisionFeature, installDecisionFeature } = await import(
		"../../features/decision/index"
	);
	const { LocalPreferences } = await import(
		"../../features/settings/local-preferences"
	);
	const storage = new Map<string, unknown>();
	const preferences = new LocalPreferences({
		getStorageSync: (key) => storage.get(key),
		setStorageSync: (key, value) => {
			storage.set(key, value);
		},
		removeStorageSync: (key) => {
			storage.delete(key);
		},
	});
	preferences.setPreferenceVector({
		quality: 100,
		time: 100,
		budget: 20,
		mealMatch: 100,
		diversity: 100,
	});
	const readVector = vi.spyOn(preferences, "preferenceVector");
	const runtime = {
		request: vi.fn(() => ({ abort() {} })),
		getLocation: vi.fn(),
		openLocation: vi.fn(),
		makePhoneCall: vi.fn(),
		setClipboardData: vi.fn(),
		showToast: vi.fn(),
	};
	const feature = createDecisionFeature({
		runtime,
		apiBaseUrl: "https://api.unfinished-era.com/",
	});
	installDecisionFeature(feature);
	feature.controller.setAccessPolicy({
		generation: 1,
		state: "TRUSTED_COMPATIBLE",
		recommendationsEnabled: true,
		locationSearchEnabled: true,
		aiEnabled: false,
		dataRightsMode: mode,
	});
	let options: Record<string, unknown> = {};
	vi.stubGlobal("wx", runtime);
	vi.stubGlobal("Page", (value) => {
		options = value;
	});
	vi.stubGlobal("getApp", () => ({
		globalData: {
			preferences,
			featureConfig: {
				current: () => ({
					kind: "READY",
					config: {
						dataRightsMode: mode,
						aiEnabled: false,
						supportFeedbackEnabled: false,
						persistenceCapabilities: {},
						minimumSupportedVersion: "99.0.0",
						minimumSupportedVersions: {
							android: "99.0.0",
							miniprogram: "0.1.0",
						},
					},
				}),
			},
		},
	}));
	await import("./index");
	const page = {
		...options,
		data: { ...(options.data as object) },
		setData(patch: object) {
			Object.assign(this.data, patch);
		},
	} as unknown as {
		data: Record<string, unknown>;
		onShow(): void;
		onHide(): void;
		onWeight(e: object): void;
		onClearWeights(): void;
	};
	return { page, feature, preferences, readVector };
}

describe("settings preferences and platform version", () => {
	it("restores and saves five weights in licensed mode, while showing the mini-program version", async () => {
		const { page, feature, preferences } = await setup("LICENSED_ENRICHMENT");
		page.onShow();
		expect(feature.controller.state.form.preferenceVector.budget).toBe(20);
		page.onWeight({
			detail: { value: 50 },
			currentTarget: { dataset: { key: "budget" } },
		});
		expect(preferences.preferenceVector().budget).toBe(50);
		expect(page.data.versionMessage).toContain("0.1.0");
		expect(page.data.versionMessage).not.toContain("99.0.0");
		page.onHide();
		feature.controller.dispose();
	});

	it("does not apply or edit local weights in live mode but lets users clear them", async () => {
		const { page, feature, preferences, readVector } =
			await setup("LIVE_DISPLAY_ONLY");
		page.onShow();
		page.onWeight({
			detail: { value: 50 },
			currentTarget: { dataset: { key: "budget" } },
		});
		expect(readVector).not.toHaveBeenCalled();
		expect(feature.controller.state.form.preferenceVector.budget).toBe(100);
		expect(page.data.preferenceEditable).toBe(false);
		expect(page.data.preferenceStored).toBe(true);
		page.onClearWeights();
		expect(preferences.hasPreferenceVector()).toBe(false);
		page.onHide();
		feature.controller.dispose();
	});
});
