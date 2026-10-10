import { describe, expect, it } from "vitest";
import { LocalPreferences } from "./local-preferences";

class MemoryStorage {
	readonly values = new Map<string, unknown>();
	getStorageSync(key: string): unknown {
		return this.values.get(key);
	}
	setStorageSync(key: string, value: unknown): void {
		this.values.set(key, value);
	}
	removeStorageSync(key: string): void {
		this.values.delete(key);
	}
}

describe("LocalPreferences", () => {
	it("persists only a complete bounded preference vector and retains it when theme changes", () => {
		const storage = new MemoryStorage();
		const preferences = new LocalPreferences(storage);
		const vector = { quality: 70, time: 90, budget: 80, mealMatch: 40, diversity: 10 };
		preferences.setPreferenceVector(vector);
		preferences.setTheme("DARK");
		expect(preferences.preferenceVector()).toEqual(vector);
		expect(preferences.hasPreferenceVector()).toBe(true);
		expect(() => preferences.setPreferenceVector({ ...vector, budget: 101 })).toThrow("PREFERENCE_VECTOR_INVALID");
		expect(() => preferences.setPreferenceVector({ ...vector, quality: Number.NaN })).toThrow("PREFERENCE_VECTOR_INVALID");
		preferences.clearPreferenceVector();
		expect(preferences.hasPreferenceVector()).toBe(false);
		expect(preferences.theme()).toBe("DARK");
		expect(preferences.preferenceVector()).toEqual({ quality: 100, time: 100, budget: 100, mealMatch: 100, diversity: 100 });
	});

	it("removes preference weights during consent withdrawal", () => {
		const preferences = new LocalPreferences(new MemoryStorage());
		preferences.setPreferenceVector({ quality: 50, time: 50, budget: 50, mealMatch: 50, diversity: 50 });
		preferences.clearSensitiveState();
		expect(preferences.hasPreferenceVector()).toBe(false);
	});
	it("retains only privacy-safe decision summaries", () => {
		const storage = new MemoryStorage();
		const preferences = new LocalPreferences(storage);
		preferences.recordDecision(
			{
				mealPeriod: "LUNCH",
				decisionMode: "QUICK",
				travelMode: "WALK",
				budgetMaxYuan: 50,
				availableMinutes: 45,
				resultCount: 3,
			},
			new Date("2026-08-30T00:00:00.000Z"),
		);
		expect(
			preferences.decisionHistory(new Date("2026-08-30T00:00:01.000Z")),
		).toEqual([
			{
				recordedAt: "2026-08-30T00:00:00.000Z",
				mealPeriod: "LUNCH",
				decisionMode: "QUICK",
				travelMode: "WALK",
				budgetMaxYuan: 50,
				availableMinutes: 45,
				resultCount: 3,
			},
		]);
		expect(JSON.stringify([...storage.values.values()])).not.toContain(
			"location",
		);
		expect(JSON.stringify([...storage.values.values()])).not.toContain(
			"restaurant",
		);
	});

	it("clears decision use data but retains theme on privacy withdrawal", () => {
		const storage = new MemoryStorage();
		const preferences = new LocalPreferences(storage);
		preferences.setTheme("DARK");
		preferences.setAiAssistanceEnabled(true);
		preferences.clearSensitiveState();
		expect(preferences.theme()).toBe("DARK");
		expect(preferences.aiAssistanceEnabled()).toBe(false);
		expect(preferences.decisionHistory()).toEqual([]);
	});
});
