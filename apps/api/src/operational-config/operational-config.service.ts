import { Inject, Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { DatabasePool } from "../database/database-pool.js";
import {
	AiAssistanceFlagSchema,
	CoverageSettingsSchema,
	enforceDeploymentMinimumVersion,
	MinimumAppVersionsSchema,
	OPERATIONAL_CONFIG_KEYS,
	type OperationalConfigKey,
	type OperationalConfigSnapshot,
	PromptSettingsSchema,
	RecommendationRulesSchema,
	startupOperationalConfig,
} from "./operational-config.types.js";

interface ActiveConfigRow extends QueryResultRow {
	readonly config_key: string;
	readonly version: number;
	readonly value_json: unknown;
	readonly config_schema: string;
}

export const OPERATIONAL_CONFIG_CACHE_TTL_MS = 5_000;

function expectedSchema(key: OperationalConfigKey): string {
	switch (key) {
		case "features.ai-assistance":
			return "FEATURE_FLAGS_V1";
		case "recommendations.rules":
			return "RECOMMENDATION_RULES_V1";
		case "recommendations.prompt":
			return "PROMPT_SETTINGS_V1";
		case "coverage.default":
			return "COVERAGE_SETTINGS_V1";
		case "clients.minimum-version":
			return "MINIMUM_APP_VERSION_V1";
	}
}

function configKey(value: string): OperationalConfigKey | null {
	return OPERATIONAL_CONFIG_KEYS.includes(value as OperationalConfigKey)
		? (value as OperationalConfigKey)
		: null;
}

function safeVersion(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error("运行配置版本字段无效");
	}
	return value;
}

@Injectable()
export class OperationalConfigService {
	private cached: {
		readonly value: OperationalConfigSnapshot;
		readonly expiresAt: number;
	} | null = null;
	private inFlight: Promise<OperationalConfigSnapshot> | null = null;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly database: DatabasePool,
	) {}

	async current(): Promise<OperationalConfigSnapshot> {
		if (!this.database.isEnabled())
			return startupOperationalConfig(this.config);
		const now = Date.now();
		if (this.cached !== null && this.cached.expiresAt > now)
			return this.cached.value;
		if (this.inFlight !== null) return this.inFlight;
		this.inFlight = this.refresh();
		try {
			return await this.inFlight;
		} finally {
			this.inFlight = null;
		}
	}

	private async refresh(): Promise<OperationalConfigSnapshot> {
		try {
			const result = await this.database.query<ActiveConfigRow>(
				`SELECT config_key, version, value_json, config_schema
				FROM public.runtime_list_active_app_config()`,
			);
			const completedAt = Date.now();
			const value = this.merge(result.rows, new Date(completedAt).toISOString());
			this.cached = Object.freeze({
				value,
				expiresAt: completedAt + OPERATIONAL_CONFIG_CACHE_TTL_MS,
			});
			return value;
		} catch {
			const previous = this.cached?.value ?? startupOperationalConfig(this.config);
			// Retain only diagnostic values from the last validated read. Every
			// database failure closes model transfer and recommendation execution.
			const unavailable = Object.freeze({
				...previous,
				source: previous.lastSuccessfulReadAt === null ? "SAFE_FALLBACK" as const : "STALE_CACHE" as const,
				aiAssistanceEnabled: false,
				prompt: Object.freeze({ ...previous.prompt, enabled: false }),
			});
			this.cached = Object.freeze({
				value: unavailable,
				expiresAt: Date.now() + OPERATIONAL_CONFIG_CACHE_TTL_MS,
			});
			return unavailable;
		}
	}

	private merge(
		rows: readonly ActiveConfigRow[],
		lastSuccessfulReadAt: string,
	): OperationalConfigSnapshot {
		const base = startupOperationalConfig(this.config, "DATABASE");
		let aiAssistanceEnabled = base.aiAssistanceEnabled;
		let recommendationRules = base.recommendationRules;
		let prompt = base.prompt;
		let coverage = base.coverage;
		let minimumAppVersions = base.minimumAppVersions;
		const versions = { ...base.versions };
		const seen = new Set<OperationalConfigKey>();

		for (const row of rows) {
			const key = configKey(row.config_key);
			if (
				key === null ||
				seen.has(key) ||
				row.config_schema !== expectedSchema(key)
			) {
				throw new Error("运行配置记录不符合注册表");
			}
			seen.add(key);
			versions[key] = safeVersion(row.version);
			switch (key) {
				case "features.ai-assistance":
					aiAssistanceEnabled = AiAssistanceFlagSchema.parse(
						row.value_json,
					).enabled;
					break;
				case "recommendations.rules":
					recommendationRules = Object.freeze(
						RecommendationRulesSchema.parse(row.value_json),
					);
					break;
				case "recommendations.prompt":
					prompt = Object.freeze(PromptSettingsSchema.parse(row.value_json));
					break;
				case "coverage.default":
					coverage = Object.freeze(
						CoverageSettingsSchema.parse(row.value_json),
					);
					break;
				case "clients.minimum-version":
					minimumAppVersions = MinimumAppVersionsSchema.parse(row.value_json);
					minimumAppVersions = Object.freeze({
						...minimumAppVersions,
						android: enforceDeploymentMinimumVersion(
							minimumAppVersions.android,
							this.config.features.minimumSupportedVersion,
						),
					});
					break;
			}
		}

		return Object.freeze({
			source: "DATABASE",
			lastSuccessfulReadAt,
			aiAssistanceEnabled,
			recommendationRules,
			prompt,
			coverage,
			minimumAppVersions,
			versions: Object.freeze(versions),
		});
	}
}
