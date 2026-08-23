import type { DataRightsMode, DataSourceCode } from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { DatabasePool } from "../database/database-pool.js";
import { APP_CONFIG, type AppConfig } from "./app-config.js";

export const APP_CLOCK = Symbol("APP_CLOCK");

export interface AppClock {
	now(): number;
}

export const DATA_RIGHTS_OPERATIONS = Object.freeze({
	DISPLAY_LIVE_RESULT: "DISPLAY_LIVE_RESULT",
	RESORT_LIVE_RESULT: "RESORT_LIVE_RESULT",
	PERSIST_PLACE_REFERENCE: "PERSIST_PLACE_REFERENCE",
	MODEL_PROCESS_PLACE_DATA: "MODEL_PROCESS_PLACE_DATA",
	DISPLAY_OWN_SUITABILITY: "DISPLAY_OWN_SUITABILITY",
} as const);

export type DataRightsOperation =
	(typeof DATA_RIGHTS_OPERATIONS)[keyof typeof DATA_RIGHTS_OPERATIONS];

interface AuthorizationDecisionRow extends QueryResultRow {
	readonly allowed: boolean;
}

const ENRICHMENT_OPERATIONS = Object.freeze([
	DATA_RIGHTS_OPERATIONS.DISPLAY_LIVE_RESULT,
	DATA_RIGHTS_OPERATIONS.RESORT_LIVE_RESULT,
	DATA_RIGHTS_OPERATIONS.DISPLAY_OWN_SUITABILITY,
] as const);

@Injectable()
export class DataRightsPolicy {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(APP_CLOCK) private readonly clock: AppClock,
		private readonly database: DatabasePool,
	) {}

	async effectiveMode(provider: DataSourceCode): Promise<DataRightsMode> {
		return (await this.allows(provider, ENRICHMENT_OPERATIONS))
			? "LICENSED_ENRICHMENT"
			: "LIVE_DISPLAY_ONLY";
	}

	async canPersistPlaceReference(provider: DataSourceCode): Promise<boolean> {
		return this.allows(provider, [
			DATA_RIGHTS_OPERATIONS.PERSIST_PLACE_REFERENCE,
		]);
	}

	async allowsOperation(
		provider: DataSourceCode,
		operation: DataRightsOperation,
	): Promise<boolean> {
		return this.allows(provider, [operation]);
	}

	private async allows(
		provider: DataSourceCode,
		operations: readonly DataRightsOperation[],
	): Promise<boolean> {
		const authorization = this.config.dataRightsAuthorization;
		if (
			this.config.dataRightsMode !== "LICENSED_ENRICHMENT" ||
			authorization === null ||
			!this.database.isEnabled()
		) {
			return false;
		}

		const expiresAtMs = Date.parse(authorization.expiresAt);
		if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.clock.now()) {
			return false;
		}

		try {
			const result = await this.database.query<AuthorizationDecisionRow>(
				`SELECT coalesce(bool_and(public.data_rights_authorization_allows(
					$1::uuid,
					$2::varchar,
					requested.operation_code
				)), false) AS allowed
				FROM unnest($3::text[]) AS requested(operation_code)`,
				[authorization.reference, provider, operations],
			);
			return result.rows.length === 1 && result.rows[0]?.allowed === true;
		} catch {
			// Authorization is a capability, not an availability requirement. Any
			// database/configuration failure must downgrade to live-only behavior.
			return false;
		}
	}
}
