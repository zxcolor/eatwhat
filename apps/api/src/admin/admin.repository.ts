import { Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { AdminDatabasePool } from "./admin-database.pool.js";

export interface AdminRequestBinding {
	readonly requestIpHash: string;
	readonly deviceHash: string;
	readonly bindingHashKeyVersion: string;
}

export interface AdminChallengeProof extends AdminRequestBinding {
	readonly challengeId: string;
	readonly challengeHash: string;
	readonly challengeHashKeyVersion: string;
}

export interface AdminSessionProof extends AdminRequestBinding {
	readonly sessionTokenHash: string;
	readonly sessionTokenHashKeyVersion: string;
}

export interface AdminEncryptedCredentialOption {
	readonly credentialIdCiphertext: Uint8Array;
	readonly credentialEncryptionKeyVersion: string;
}

export interface AdminLoginCredentialOption
	extends AdminEncryptedCredentialOption {
	readonly credentialId: string;
}

export interface AdminAssertionCredential {
	readonly credentialId: string;
	readonly publicKey: Uint8Array;
	readonly signatureCounter: number;
	readonly counterMode: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED";
	readonly rpIdHash: string;
	readonly rpIdHashKeyVersion: string;
	readonly originHash: string;
	readonly originHashKeyVersion: string;
	readonly userVerificationRequired: true;
}

export interface AdminAuthenticatedSession {
	readonly sessionId: string;
	readonly adminUserId: string;
	readonly permissionCodes: readonly string[];
	readonly absoluteExpiresAt: string;
}

export interface AdminLoginCompletion {
	readonly securityStatus:
		| "SESSION_ISSUED"
		| "INVALID_PROOF"
		| "EXPIRED"
		| "FAILED"
		| "RETRY_ALLOWED"
		| "COUNTER_ROLLBACK";
	readonly issuedSessionId: string | null;
	readonly authenticatedAdminUserId: string | null;
}

export interface AdminSelfCredentialRecord {
	readonly credentialHandle: string;
	readonly createdAt: string;
	readonly lastUsedAt: string | null;
}

export interface AdminSanitizedAuditEvent {
	readonly eventId: string;
	readonly action: string;
	readonly targetType: string;
	readonly createdAt: string;
	readonly configKey: string | null;
	readonly newVersion: number | null;
	readonly sourceVersion: number | null;
	readonly changeReason: string | null;
}

export interface AdminConfigurationRecord {
	readonly configKey: string;
	readonly configSchema: string;
	readonly classification: string;
	readonly version: number;
	readonly value: unknown;
	readonly changeReason: string;
	readonly createdAt: string;
	readonly activatedAt: string;
}

export interface AdminConfigurationMutationResult {
	readonly status: string;
	readonly record: AdminConfigurationRecord | null;
}

interface LoginCredentialOptionRow extends QueryResultRow {
	readonly credential_id: string;
	readonly credential_id_ciphertext: Buffer;
	readonly credential_encryption_key_version: string;
}

interface AssertionCredentialRow extends QueryResultRow {
	readonly credential_id: string;
	readonly public_key: Buffer;
	readonly signature_counter: string;
	readonly counter_mode: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED";
	readonly rp_id_hash: string;
	readonly rp_id_hash_key_version: string;
	readonly origin_hash: string;
	readonly origin_hash_key_version: string;
	readonly user_verification_required: boolean;
}

interface AuthenticationRow extends QueryResultRow {
	readonly session_id: string;
	readonly admin_user_id: string;
	readonly permission_codes: string[];
	readonly absolute_expires_at: Date | string;
}

interface CompletionRow extends QueryResultRow {
	readonly security_status: AdminLoginCompletion["securityStatus"];
	readonly issued_session_id: string | null;
	readonly authenticated_admin_user_id: string | null;
}

interface TextStatusRow extends QueryResultRow {
	readonly status: string;
}

interface SelfCredentialOptionRow extends QueryResultRow {
	readonly credential_id_ciphertext: Buffer;
	readonly credential_encryption_key_version: string;
}

interface SelfCredentialRow extends QueryResultRow {
	readonly credential_handle: string;
	readonly created_at: Date | string;
	readonly last_used_at: Date | string | null;
}

interface SanitizedAuditRow extends QueryResultRow {
	readonly event_id: string;
	readonly action: string;
	readonly target_type: string;
	readonly created_at: Date | string;
	readonly config_key: string | null;
	readonly new_version: number | null;
	readonly source_version: number | null;
	readonly change_reason: string | null;
}

interface ConfigurationRow extends QueryResultRow {
	readonly config_key: string;
	readonly config_schema: string;
	readonly classification: string;
	readonly version: number;
	readonly value_json: unknown;
	readonly change_reason: string;
	readonly created_at: Date | string;
	readonly activated_at: Date | string;
}

interface ConfigurationMutationRow extends QueryResultRow {
	readonly status: string;
	readonly config_key: string | null;
	readonly config_schema: string | null;
	readonly classification: string | null;
	readonly version: number | null;
	readonly value_json: unknown;
	readonly change_reason: string | null;
	readonly created_at: Date | string | null;
	readonly activated_at: Date | string | null;
}

function isoDate(value: Date | string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error("数据库时间字段无效");
	return date.toISOString();
}

function safeCounter(value: string): number {
	if (!/^\d+$/u.test(value)) throw new Error("管理员计数器字段无效");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error("管理员计数器字段无效");
	}
	return parsed;
}

@Injectable()
export class AdminRepository {
	constructor(private readonly database: AdminDatabasePool) {}

	isAvailable(): boolean {
		return this.database.isAvailable();
	}

	async beginLoginChallenge(input: {
		readonly challengeId: string;
		readonly loginLookupCandidates: readonly {
			readonly value: string;
			readonly keyVersion: string;
		}[];
		readonly challengeHash: string;
		readonly challengeHashKeyVersion: string;
		readonly binding: AdminRequestBinding;
	}): Promise<void> {
		await this.database.query(
			`SELECT public.admin_begin_login_challenge(
				$1::uuid, $2::varchar[], $3::varchar[], $4::varchar, $5::varchar,
				$6::varchar, $7::varchar, $8::varchar
			)`,
			[
				input.challengeId,
				input.loginLookupCandidates.map(({ value }) => value),
				input.loginLookupCandidates.map(({ keyVersion }) => keyVersion),
				input.challengeHash,
				input.challengeHashKeyVersion,
				input.binding.requestIpHash,
				input.binding.deviceHash,
				input.binding.bindingHashKeyVersion,
			],
		);
	}

	async getLoginCredentialOptions(
		proof: AdminChallengeProof,
	): Promise<readonly AdminLoginCredentialOption[]> {
		const result = await this.database.query<LoginCredentialOptionRow>(
			`SELECT credential_id, credential_id_ciphertext,
				credential_encryption_key_version
			FROM public.admin_get_login_credential_options(
				$1::uuid, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar
			)`,
			this.challengeValues(proof),
		);
		return Object.freeze(
			result.rows.map((row) =>
				Object.freeze({
					credentialId: row.credential_id,
					credentialIdCiphertext: Buffer.from(row.credential_id_ciphertext),
					credentialEncryptionKeyVersion: row.credential_encryption_key_version,
				}),
			),
		);
	}

	async getAssertionCredential(
		proof: AdminChallengeProof,
		credentialIdHash: string,
		credentialHashKeyVersion: string,
	): Promise<AdminAssertionCredential | null> {
		const result = await this.database.query<AssertionCredentialRow>(
			`SELECT credential_id, public_key, signature_counter, counter_mode,
				rp_id_hash, rp_id_hash_key_version, origin_hash,
				origin_hash_key_version, user_verification_required
			FROM public.admin_get_assertion_credential(
				$1::uuid, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar, $7::varchar, $8::varchar
			)`,
			[
				...this.challengeValues(proof),
				credentialIdHash,
				credentialHashKeyVersion,
			],
		);
		const row = result.rows[0];
		if (row === undefined) return null;
		if (row.user_verification_required !== true) {
			throw new Error("管理员凭据安全状态无效");
		}
		return Object.freeze({
			credentialId: row.credential_id,
			publicKey: Buffer.from(row.public_key),
			signatureCounter: safeCounter(row.signature_counter),
			counterMode: row.counter_mode,
			rpIdHash: row.rp_id_hash,
			rpIdHashKeyVersion: row.rp_id_hash_key_version,
			originHash: row.origin_hash,
			originHashKeyVersion: row.origin_hash_key_version,
			userVerificationRequired: true,
		});
	}

	async failLoginChallenge(proof: AdminChallengeProof): Promise<string> {
		const result = await this.database.query<TextStatusRow>(
			`SELECT public.admin_fail_login_challenge(
				$1::uuid, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar
			) AS status`,
			this.challengeValues(proof),
		);
		return result.rows[0]?.status ?? "INVALID_PROOF";
	}

	async completeLoginAssertion(input: {
		readonly proof: AdminChallengeProof;
		readonly credentialIdHash: string;
		readonly credentialHashKeyVersion: string;
		readonly verifiedOriginHash: string;
		readonly originHashKeyVersion: string;
		readonly verifiedRpIdHash: string;
		readonly rpIdHashKeyVersion: string;
		readonly newSignatureCounter: number;
		readonly sessionId: string;
		readonly sessionTokenHash: string;
		readonly sessionTokenHashKeyVersion: string;
	}): Promise<AdminLoginCompletion> {
		const result = await this.database.query<CompletionRow>(
			`SELECT security_status, issued_session_id,
				authenticated_admin_user_id
			FROM public.admin_complete_login_assertion(
				$1::uuid, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar, $7::varchar, $8::varchar,
				$9::varchar, $10::varchar, $11::varchar, $12::varchar,
				true, $13::bigint, $14::uuid, $15::varchar, $16::varchar
			)`,
			[
				...this.challengeValues(input.proof),
				input.credentialIdHash,
				input.credentialHashKeyVersion,
				input.verifiedOriginHash,
				input.originHashKeyVersion,
				input.verifiedRpIdHash,
				input.rpIdHashKeyVersion,
				input.newSignatureCounter,
				input.sessionId,
				input.sessionTokenHash,
				input.sessionTokenHashKeyVersion,
			],
		);
		const row = result.rows[0];
		if (row === undefined) throw new Error("管理员登录完成状态缺失");
		return Object.freeze({
			securityStatus: row.security_status,
			issuedSessionId: row.issued_session_id,
			authenticatedAdminUserId: row.authenticated_admin_user_id,
		});
	}

	async authenticateSession(
		proof: AdminSessionProof,
	): Promise<AdminAuthenticatedSession | null> {
		const result = await this.database.query<AuthenticationRow>(
			`SELECT session_id, admin_user_id, permission_codes,
				absolute_expires_at
			FROM public.admin_authenticate_session(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar
			)`,
			[
				proof.sessionTokenHash,
				proof.sessionTokenHashKeyVersion,
				proof.requestIpHash,
				proof.deviceHash,
				proof.bindingHashKeyVersion,
			],
		);
		const row = result.rows[0];
		if (row === undefined) return null;
		return Object.freeze({
			sessionId: row.session_id,
			adminUserId: row.admin_user_id,
			permissionCodes: Object.freeze([...row.permission_codes]),
			absoluteExpiresAt: isoDate(row.absolute_expires_at),
		});
	}

	async logoutSession(proof: AdminSessionProof): Promise<boolean> {
		const result = await this.database.query<
			QueryResultRow & { result: boolean }
		>(
			`SELECT public.admin_logout_session(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar
			) AS result`,
			[
				proof.sessionTokenHash,
				proof.sessionTokenHashKeyVersion,
				proof.deviceHash,
				proof.bindingHashKeyVersion,
			],
		);
		return result.rows[0]?.result === true;
	}

	async beginEnrollChallenge(input: {
		readonly session: AdminSessionProof;
		readonly challengeId: string;
		readonly challengeHash: string;
		readonly challengeHashKeyVersion: string;
	}): Promise<boolean> {
		const result = await this.database.query<
			QueryResultRow & { result: boolean }
		>(
			`SELECT public.admin_begin_enroll_challenge(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::uuid, $7::varchar, $8::varchar
			) AS result`,
			[
				input.session.sessionTokenHash,
				input.session.sessionTokenHashKeyVersion,
				input.session.requestIpHash,
				input.session.deviceHash,
				input.session.bindingHashKeyVersion,
				input.challengeId,
				input.challengeHash,
				input.challengeHashKeyVersion,
			],
		);
		return result.rows[0]?.result === true;
	}

	async failEnrollChallenge(proof: AdminChallengeProof): Promise<string> {
		const result = await this.database.query<TextStatusRow>(
			`SELECT public.admin_fail_enroll_challenge(
				$1::uuid, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar
			) AS status`,
			this.challengeValues(proof),
		);
		return result.rows[0]?.status ?? "INVALID_PROOF";
	}

	async getSelfEnrollCredentialOptions(input: {
		readonly session: AdminSessionProof;
		readonly challenge: AdminChallengeProof;
	}): Promise<readonly AdminEncryptedCredentialOption[]> {
		const result = await this.database.query<SelfCredentialOptionRow>(
			`SELECT credential_id_ciphertext, credential_encryption_key_version
			FROM public.admin_get_self_enroll_credential_options(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::uuid, $7::varchar, $8::varchar
			)`,
			[
				...this.sessionValues(input.session),
				input.challenge.challengeId,
				input.challenge.challengeHash,
				input.challenge.challengeHashKeyVersion,
			],
		);
		return Object.freeze(
			result.rows.map((row) =>
				Object.freeze({
					credentialIdCiphertext: Buffer.from(row.credential_id_ciphertext),
					credentialEncryptionKeyVersion: row.credential_encryption_key_version,
				}),
			),
		);
	}

	async completeCredentialEnrollment(input: {
		readonly proof: AdminChallengeProof;
		readonly credentialId: string;
		readonly credentialIdHash: string;
		readonly credentialHashKeyVersion: string;
		readonly credentialIdCiphertext: Uint8Array;
		readonly credentialEncryptionKeyVersion: string;
		readonly publicKey: Uint8Array;
		readonly verifiedOriginHash: string;
		readonly originHashKeyVersion: string;
		readonly verifiedRpIdHash: string;
		readonly rpIdHashKeyVersion: string;
		readonly initialSignatureCounter: number;
	}): Promise<string> {
		const result = await this.database.query<TextStatusRow>(
			`SELECT public.admin_complete_credential_enrollment(
				$1::uuid, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar, $7::uuid, $8::varchar,
				$9::varchar, $10::bytea, $11::varchar, $12::bytea,
				$13::varchar, $14::varchar, $15::varchar, $16::varchar,
				true, $17::bigint
			) AS status`,
			[
				...this.challengeValues(input.proof),
				input.credentialId,
				input.credentialIdHash,
				input.credentialHashKeyVersion,
				Buffer.from(input.credentialIdCiphertext),
				input.credentialEncryptionKeyVersion,
				Buffer.from(input.publicKey),
				input.verifiedOriginHash,
				input.originHashKeyVersion,
				input.verifiedRpIdHash,
				input.rpIdHashKeyVersion,
				input.initialSignatureCounter,
			],
		);
		return result.rows[0]?.status ?? "INVALID_PROOF";
	}

	async listSelfCredentials(
		session: AdminSessionProof,
	): Promise<readonly AdminSelfCredentialRecord[]> {
		const result = await this.database.query<SelfCredentialRow>(
			`SELECT credential_handle, created_at, last_used_at
			FROM public.admin_list_self_credentials(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar
			)`,
			this.sessionValues(session),
		);
		return Object.freeze(result.rows.map((row) => this.selfCredential(row)));
	}

	async getSelfCredentialRecord(
		session: AdminSessionProof,
		internalCredentialId: string,
	): Promise<AdminSelfCredentialRecord | null> {
		const result = await this.database.query<SelfCredentialRow>(
			`SELECT credential_handle, created_at, last_used_at
			FROM public.admin_get_self_credential_record(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::uuid
			)`,
			[...this.sessionValues(session), internalCredentialId],
		);
		const row = result.rows[0];
		return row === undefined ? null : this.selfCredential(row);
	}

	async revokeSelfCredential(
		session: AdminSessionProof,
		credentialHandle: string,
	): Promise<string> {
		const result = await this.database.query<TextStatusRow>(
			`SELECT public.admin_revoke_self_credential(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar
			) AS status`,
			[...this.sessionValues(session), credentialHandle],
		);
		return result.rows[0]?.status ?? "UNAUTHORIZED";
	}

	async listSanitizedAuditEvents(input: {
		readonly session: AdminSessionProof;
		readonly beforeCreatedAt: string | null;
		readonly beforeEventId: string | null;
		readonly pageSize: number;
	}): Promise<readonly AdminSanitizedAuditEvent[]> {
		const result = await this.database.query<SanitizedAuditRow>(
			`SELECT event_id, action, target_type, created_at, config_key,
				new_version, source_version, change_reason
			FROM public.admin_list_sanitized_audit_events_v2(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::timestamptz, $7::uuid, $8::integer
			)`,
			[
				...this.sessionValues(input.session),
				input.beforeCreatedAt,
				input.beforeEventId,
				input.pageSize,
			],
		);
		return Object.freeze(
			result.rows.map((row) =>
				Object.freeze({
					eventId: row.event_id,
					action: row.action,
					targetType: row.target_type,
					createdAt: isoDate(row.created_at),
					configKey: row.config_key,
					newVersion: row.new_version,
					sourceVersion: row.source_version,
					changeReason: row.change_reason,
				}),
			),
		);
	}

	async listActiveConfiguration(
		session: AdminSessionProof,
	): Promise<readonly AdminConfigurationRecord[]> {
		const result = await this.database.query<ConfigurationRow>(
			`SELECT config_key, config_schema, classification, version,
				value_json, change_reason, created_at, activated_at
			FROM public.admin_list_active_app_config(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar
			)`,
			this.sessionValues(session),
		);
		return Object.freeze(
			result.rows.map((row) => this.configurationRecord(row)),
		);
	}

	async listConfigurationHistory(input: {
		readonly session: AdminSessionProof;
		readonly configKey: string;
		readonly pageSize: number;
	}): Promise<readonly AdminConfigurationRecord[]> {
		const result = await this.database.query<ConfigurationRow>(
			`SELECT config_key, config_schema, classification, version,
				value_json, change_reason, created_at, activated_at
			FROM public.admin_list_app_config_history(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar, $7::integer
			)`,
			[...this.sessionValues(input.session), input.configKey, input.pageSize],
		);
		return Object.freeze(
			result.rows.map((row) => this.configurationRecord(row)),
		);
	}

	async publishConfiguration(input: {
		readonly session: AdminSessionProof;
		readonly configKey: string;
		readonly expectedActiveVersion: number | null;
		readonly value: unknown;
		readonly changeReason: string;
	}): Promise<AdminConfigurationMutationResult> {
		const result = await this.database.query<ConfigurationMutationRow>(
			`SELECT status, config_key, config_schema, classification, version,
				value_json, change_reason, created_at, activated_at
			FROM public.admin_publish_app_config(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar, $7::integer, $8::jsonb, $9::varchar
			)`,
			[
				...this.sessionValues(input.session),
				input.configKey,
				input.expectedActiveVersion,
				input.value,
				input.changeReason,
			],
		);
		return this.configurationMutation(result.rows[0]);
	}

	async rollbackConfiguration(input: {
		readonly session: AdminSessionProof;
		readonly configKey: string;
		readonly expectedActiveVersion: number;
		readonly targetVersion: number;
		readonly changeReason: "ROLLBACK";
	}): Promise<AdminConfigurationMutationResult> {
		const result = await this.database.query<ConfigurationMutationRow>(
			`SELECT status, config_key, config_schema, classification, version,
				value_json, change_reason, created_at, activated_at
			FROM public.admin_rollback_app_config(
				$1::varchar, $2::varchar, $3::varchar, $4::varchar,
				$5::varchar, $6::varchar, $7::integer, $8::integer, $9::varchar
			)`,
			[
				...this.sessionValues(input.session),
				input.configKey,
				input.expectedActiveVersion,
				input.targetVersion,
				input.changeReason,
			],
		);
		return this.configurationMutation(result.rows[0]);
	}

	private challengeValues(proof: AdminChallengeProof): readonly unknown[] {
		return [
			proof.challengeId,
			proof.challengeHash,
			proof.challengeHashKeyVersion,
			proof.requestIpHash,
			proof.deviceHash,
			proof.bindingHashKeyVersion,
		];
	}

	private sessionValues(proof: AdminSessionProof): readonly unknown[] {
		return [
			proof.sessionTokenHash,
			proof.sessionTokenHashKeyVersion,
			proof.requestIpHash,
			proof.deviceHash,
			proof.bindingHashKeyVersion,
		];
	}

	private selfCredential(row: SelfCredentialRow): AdminSelfCredentialRecord {
		return Object.freeze({
			credentialHandle: row.credential_handle,
			createdAt: isoDate(row.created_at),
			lastUsedAt: row.last_used_at === null ? null : isoDate(row.last_used_at),
		});
	}

	private configurationRecord(row: ConfigurationRow): AdminConfigurationRecord {
		return Object.freeze({
			configKey: row.config_key,
			configSchema: row.config_schema,
			classification: row.classification,
			version: row.version,
			value: row.value_json,
			changeReason: row.change_reason,
			createdAt: isoDate(row.created_at),
			activatedAt: isoDate(row.activated_at),
		});
	}

	private configurationMutation(
		row: ConfigurationMutationRow | undefined,
	): AdminConfigurationMutationResult {
		if (row === undefined) {
			return Object.freeze({ status: "UNAVAILABLE", record: null });
		}
		if (
			row.config_key === null ||
			row.config_schema === null ||
			row.classification === null ||
			row.version === null ||
			row.change_reason === null ||
			row.created_at === null ||
			row.activated_at === null
		) {
			return Object.freeze({ status: row.status, record: null });
		}
		return Object.freeze({
			status: row.status,
			record: this.configurationRecord({
				...row,
				config_key: row.config_key,
				config_schema: row.config_schema,
				classification: row.classification,
				version: row.version,
				change_reason: row.change_reason,
				created_at: row.created_at,
				activated_at: row.activated_at,
			}),
		});
	}
}
