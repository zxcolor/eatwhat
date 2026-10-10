import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("Android-aligned home interactions", () => {
	it("applies real scenarios while retaining the chosen location, and reveals only supported profiles", async () => {
		vi.resetModules();
		const {
			createDecisionFeature,
			installDecisionFeature,
			BUILT_IN_QUICK_LOCATIONS,
		} = await import("../../features/decision/index");
		const runtime = {
			request: vi.fn(() => ({ abort() {} })),
			getLocation: vi.fn(),
			openLocation: vi.fn(),
			makePhoneCall: vi.fn(),
			setClipboardData: vi.fn(),
			hideShareMenu: vi.fn(),
			navigateTo: vi.fn(),
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
			dataRightsMode: "LIVE_DISPLAY_ONLY",
		});
		let options: Record<string, unknown> = {};
		vi.stubGlobal("wx", runtime);
		vi.stubGlobal("Page", (value) => {
			options = value;
		});
		vi.stubGlobal("getApp", () => ({
			globalData: {
				consent: { isAllowed: () => true },
				preferences: { theme: () => "LIGHT" },
				initializeAfterConsent: async () => ({ kind: "UNAVAILABLE" }),
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
			onLoad(): Promise<void>;
			onSelectBuiltInLocation(e: object): void;
			onScenario(e: object): void;
			onMinutesInput(e: object): void;
			onUnload(): void;
		};
		await page.onLoad();
		page.onSelectBuiltInLocation({ currentTarget: { dataset: { index: 0 } } });
		page.onScenario({ currentTarget: { dataset: { value: "IN_A_HURRY" } } });
		expect(feature.controller.state.form.location?.label).toBe(
			BUILT_IN_QUICK_LOCATIONS[0]?.label,
		);
		expect(feature.controller.state.form.availableMinutes).toBe(30);
		expect(feature.controller.state.form.radiusMeters).toBe(1_000);
		expect(
			(page.data.mealPeriods as { value: string }[]).map((item) => item.value),
		).toEqual(["LUNCH"]);
		expect(page.data.softPreferencesAvailable).toBe(false);
		page.onMinutesInput({ detail: { value: "45" } });
		expect(feature.controller.state.activeScenario).toBeNull();
		expect(runtime.request).not.toHaveBeenCalled();
		page.onUnload();
		feature.controller.dispose();
	});
});
