import type { RecommendationPreferenceVector as PreferenceVector } from "../decision/types";

export type ThemePreference = "SYSTEM" | "LIGHT" | "DARK";

export interface LocalDecisionHistoryEntry {
	readonly recordedAt: string;
	readonly mealPeriod: "BREAKFAST" | "LUNCH" | "DINNER";
	readonly decisionMode: "QUICK" | "GUIDED";
	readonly travelMode: "WALK" | "BIKE" | "TRANSIT";
	readonly budgetMaxYuan: number | null;
	readonly availableMinutes: number;
	readonly resultCount: number;
}

interface StoragePort {
	getStorageSync(key: string): unknown;
	setStorageSync(key: string, value: unknown): void;
	removeStorageSync(key: string): void;
}

const PREFERENCE_KEY = "chi-shen-me.preferences.v1";
const DECISION_HISTORY_KEY = "chi-shen-me.local-decision-history.v1";
const RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000;
const MAXIMUM_HISTORY_ITEMS = 30;

export class LocalPreferences {
	constructor(private readonly storage: StoragePort) {}

	theme(): ThemePreference {
		const source = this.preferenceRecord();
		return source.theme === "LIGHT" || source.theme === "DARK"
			? source.theme
			: "SYSTEM";
	}

	setTheme(theme: ThemePreference): void {
		this.savePreferences({ ...this.preferenceRecord(), theme });
	}

	aiAssistanceEnabled(): boolean {
		return this.preferenceRecord().aiAssistanceEnabled === true;
	}

	setAiAssistanceEnabled(enabled: boolean): void {
		this.savePreferences({
			...this.preferenceRecord(),
			aiAssistanceEnabled: enabled,
		});
	}

	preferenceVector(): PreferenceVector {
		return parsePreferenceVector(this.preferenceRecord().preferenceVector) ?? {
			quality: 100, time: 100, budget: 100, mealMatch: 100, diversity: 100,
		};
	}

	hasPreferenceVector(): boolean {
		return parsePreferenceVector(this.preferenceRecord().preferenceVector) !== null;
	}

	setPreferenceVector(vector: PreferenceVector): void {
		const parsed = parsePreferenceVector(vector);
		if (parsed === null) throw new Error("PREFERENCE_VECTOR_INVALID");
		this.savePreferences({ ...this.preferenceRecord(), preferenceVector: parsed });
	}

	clearPreferenceVector(): void {
		const { preferenceVector: _, ...remaining } = this.preferenceRecord();
		this.savePreferences(remaining);
	}

	decisionHistory(
		now: Date = new Date(),
	): readonly LocalDecisionHistoryEntry[] {
		const raw = this.storage.getStorageSync(DECISION_HISTORY_KEY);
		if (!Array.isArray(raw)) {
			if (raw !== undefined && raw !== null && raw !== "")
				this.storage.removeStorageSync(DECISION_HISTORY_KEY);
			return [];
		}
		const minimumTime = now.getTime() - RETENTION_MILLISECONDS;
		const valid = raw
			.map(parseHistoryEntry)
			.filter((item): item is LocalDecisionHistoryEntry => item !== null)
			.filter((item) => Date.parse(item.recordedAt) >= minimumTime)
			.slice(0, MAXIMUM_HISTORY_ITEMS);
		if (valid.length !== raw.length)
			this.storage.setStorageSync(DECISION_HISTORY_KEY, valid);
		return Object.freeze(valid);
	}

	recordDecision(
		entry: Omit<LocalDecisionHistoryEntry, "recordedAt">,
		now: Date = new Date(),
	): void {
		const candidate = parseHistoryEntry({
			...entry,
			recordedAt: now.toISOString(),
		});
		if (candidate === null) throw new Error("LOCAL_DECISION_HISTORY_INVALID");
		this.storage.setStorageSync(
			DECISION_HISTORY_KEY,
			[candidate, ...this.decisionHistory(now)].slice(0, MAXIMUM_HISTORY_ITEMS),
		);
	}

	clearDecisionHistory(): void {
		this.storage.removeStorageSync(DECISION_HISTORY_KEY);
	}

	/** Keeps display preference while clearing data tied to product use. */
	clearSensitiveState(): void {
		this.clearDecisionHistory();
		const theme = this.theme();
		this.storage.setStorageSync(PREFERENCE_KEY, {
			version: 1,
			theme,
			aiAssistanceEnabled: false,
		});
	}

	private preferenceRecord(): Record<string, unknown> {
		const raw = this.storage.getStorageSync(PREFERENCE_KEY);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw))
			return {};
		const source = raw as Record<string, unknown>;
		if (source.version !== 1) return {};
		return source;
	}

	private savePreferences(value: Record<string, unknown>): void {
		this.storage.setStorageSync(PREFERENCE_KEY, {
			version: 1,
			theme:
				value.theme === "LIGHT" || value.theme === "DARK"
					? value.theme
					: "SYSTEM",
			aiAssistanceEnabled: value.aiAssistanceEnabled === true,
			...(parsePreferenceVector(value.preferenceVector) === null
				? {} : { preferenceVector: parsePreferenceVector(value.preferenceVector) }),
		});
	}
}

function parsePreferenceVector(value: unknown): PreferenceVector | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const vector = value as Record<string, unknown>;
	const keys = ["quality", "time", "budget", "mealMatch", "diversity"] as const;
	if (Object.keys(vector).length !== keys.length || keys.some((key) =>
		typeof vector[key] !== "number" || !Number.isInteger(vector[key]) || (vector[key] as number) < 0 || (vector[key] as number) > 100,
	)) return null;
	return Object.freeze({ quality: vector.quality as number, time: vector.time as number, budget: vector.budget as number, mealMatch: vector.mealMatch as number, diversity: vector.diversity as number });
}

function parseHistoryEntry(value: unknown): LocalDecisionHistoryEntry | null {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const source = value as Record<string, unknown>;
	if (
		Object.keys(source).sort().join(",") !==
			"availableMinutes,budgetMaxYuan,decisionMode,mealPeriod,recordedAt,resultCount,travelMode" ||
		typeof source.recordedAt !== "string" ||
		Number.isNaN(Date.parse(source.recordedAt)) ||
		(source.mealPeriod !== "BREAKFAST" &&
			source.mealPeriod !== "LUNCH" &&
			source.mealPeriod !== "DINNER") ||
		(source.decisionMode !== "QUICK" && source.decisionMode !== "GUIDED") ||
		(source.travelMode !== "WALK" &&
			source.travelMode !== "BIKE" &&
			source.travelMode !== "TRANSIT") ||
		(source.budgetMaxYuan !== null &&
			(typeof source.budgetMaxYuan !== "number" ||
				!Number.isInteger(source.budgetMaxYuan) ||
				source.budgetMaxYuan < 1 ||
				source.budgetMaxYuan > 2_000)) ||
		typeof source.availableMinutes !== "number" ||
		!Number.isInteger(source.availableMinutes) ||
		source.availableMinutes < 15 ||
		source.availableMinutes > 240 ||
		typeof source.resultCount !== "number" ||
		!Number.isInteger(source.resultCount) ||
		source.resultCount < 0 ||
		source.resultCount > 3
	) {
		return null;
	}
	return Object.freeze({
		recordedAt: source.recordedAt,
		mealPeriod: source.mealPeriod,
		decisionMode: source.decisionMode,
		travelMode: source.travelMode,
		budgetMaxYuan: source.budgetMaxYuan,
		availableMinutes: source.availableMinutes,
		resultCount: source.resultCount,
	});
}
