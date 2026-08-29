import { Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import {
	DatabasePool,
	type DatabaseTransaction,
} from "../database/database-pool.js";
import type { VersionedHash } from "./auth-crypto.js";
import type {
	AuthenticatedSession,
	AuthOAuthPurpose,
	AuthOtpPurpose,
	CompleteCredentialResult,
	CompleteOAuthCredentialResult,
	CreateOAuthStateResult,
	CreateOtpChallengeResult,
	OAuthProof,
	OAuthStateDraft,
	OtpChallengeDraft,
	OtpProof,
	RefreshIssueDraft,
	RefreshSessionResult,
	SessionIssueDraft,
	VerifiedOAuthHashes,
} from "./auth-workflow.types.js";
import type { AuthenticatedUserContext } from "./authenticated-user.resolver.js";

interface BooleanRow extends QueryResultRow {
	readonly changed: boolean;
}
interface OtpExistingRow extends QueryResultRow {
	readonly id: string;
	readonly masked_destination: string;
	readonly expires_at: Date | string;
	readonly created_at: Date | string;
}
interface CountRow extends QueryResultRow {
	readonly destination_hour_count: string | number;
	readonly destination_day_count: string | number;
	readonly device_count: string | number;
	readonly ip_count: string | number;
	readonly pending_count: string | number;
	readonly destination_hour_oldest: Date | string | null;
	readonly destination_day_oldest: Date | string | null;
	readonly device_oldest: Date | string | null;
	readonly ip_oldest: Date | string | null;
	readonly pending_oldest: Date | string | null;
}
interface OtpProofRow extends QueryResultRow {
	readonly id: string;
	readonly channel: "PHONE" | "EMAIL";
	readonly purpose: "REGISTER" | "LOGIN" | "BIND" | "RECOVERY";
	readonly destination_dedup_hash: string;
	readonly verification_method: "ALIYUN_PNVS" | "LOCAL_HASH";
	readonly code_hash: string | null;
	readonly code_hash_key_version: string | null;
	readonly operation_target_hash: string | null;
	readonly target_user_id: string | null;
	readonly registration_flow_reference_hash: string | null;
	readonly device_hash: string;
	readonly hash_key_version: string;
}
interface OAuthProofRow extends QueryResultRow {
	readonly id: string;
	readonly provider: "WECHAT" | "QQ";
	readonly purpose: "LOGIN" | "BIND";
	readonly flow_reference_hash: string;
	readonly operation_target_hash: string | null;
	readonly target_user_id: string | null;
	readonly device_hash: string;
	readonly hash_key_version: string;
}
interface UserRow extends QueryResultRow {
	readonly user_id: string;
}
interface UuidRow extends QueryResultRow {
	readonly id: string | null;
}
interface IdentityOwnerRow extends QueryResultRow {
	readonly user_id: string;
	readonly revoked_at: Date | string | null;
}
interface OAuthOwnerRow extends IdentityOwnerRow {
	readonly user_status: "ACTIVE" | "LOCKED" | "DELETION_PENDING";
}
interface IdentityBindingRow extends QueryResultRow {
	readonly id: string;
	readonly identity_type: "PHONE" | "EMAIL" | "WECHAT" | "QQ";
	readonly masked_display_hint: string;
	readonly is_primary: boolean;
	readonly verified_at: Date | string;
	readonly revoked_at: Date | string | null;
}
interface SessionRow extends QueryResultRow {
	readonly id: string;
	readonly device_label: string;
	readonly platform: "ANDROID";
	readonly created_at: Date | string;
	readonly last_seen_at: Date | string;
	readonly refresh_expires_at: Date | string;
	readonly status: "ACTIVE" | "REVOKED" | "COMPROMISED";
	readonly revoked_at: Date | string | null;
}
interface TimestampRow extends QueryResultRow {
	readonly occurred_at: Date | string;
}
interface ExportQueueRow extends QueryResultRow {
	readonly outcome: "CREATED" | "REPLAY" | "CONFLICT" | "INVALID_USER";
	readonly export_id: string | null;
	readonly export_status: DataExportStatus | null;
	readonly requested_at: Date | string | null;
	readonly ready_at: Date | string | null;
	readonly expires_at: Date | string | null;
	readonly include_behavior_history: boolean | null;
	readonly failure_code: string | null;
	readonly artifact_size_bytes: number | string | null;
	readonly artifact_sha256: string | null;
}
interface ExportStatusRow extends QueryResultRow {
	readonly export_id: string;
	readonly export_status: DataExportStatus;
	readonly requested_at: Date | string;
	readonly ready_at: Date | string | null;
	readonly expires_at: Date | string;
	readonly include_behavior_history: boolean;
	readonly failure_code: string | null;
	readonly artifact_size_bytes: number | string | null;
	readonly artifact_sha256: string | null;
}
interface ExportArtifactRow extends QueryResultRow {
	readonly artifact_locator_ciphertext: Buffer;
	readonly artifact_encryption_key_version: string;
	readonly artifact_size_bytes: number | string;
	readonly artifact_sha256: string;
	readonly artifact_content_type: string;
}
interface DeletionJobRow extends QueryResultRow {
	readonly requested_at: Date | string;
	readonly purge_due_at: Date | string;
}
interface AccessSessionRow extends QueryResultRow {
	readonly user_id: string;
	readonly session_id: string;
	readonly device_hash: string;
	readonly hash_key_version: string;
}
interface RefreshCredentialRow extends QueryResultRow {
	readonly credential_id: string;
	readonly session_family_id: string;
	readonly generation: number;
	readonly consumed_at: Date | string | null;
	readonly replay_detected_at: Date | string | null;
	readonly credential_expires_at: Date | string;
	readonly family_status: "ACTIVE" | "REVOKED" | "COMPROMISED";
	readonly refresh_expires_at: Date | string;
	readonly device_hash: string;
	readonly user_id: string;
	readonly user_status: "ACTIVE" | "LOCKED" | "DELETION_PENDING";
}

export interface OtpLoginCompletion {
	readonly proof: OtpProof;
	readonly verificationSucceeded: boolean;
	readonly session: SessionIssueDraft | null;
	readonly newUserId: string | null;
	readonly verificationClaimHash: string | null;
}
export interface OAuthLoginCompletion {
	readonly proof: OAuthProof;
	readonly verifiedIdentity: VerifiedOAuthHashes;
	readonly session: SessionIssueDraft;
}
export interface IdentityBindingRecord {
	readonly bindingId: string;
	readonly type: "PHONE" | "EMAIL" | "WECHAT" | "QQ";
	readonly maskedValue: string;
	readonly boundAt: Date;
	readonly primary: boolean;
	readonly canUnbind: boolean;
	readonly revokedAt: Date | null;
}

export interface OtpBindingCompletion {
	readonly session: AuthenticatedUserContext;
	readonly proof: OtpProof;
	readonly verificationSucceeded: boolean;
}

export interface OAuthBindingCompletion {
	readonly session: AuthenticatedUserContext;
	readonly proof: OAuthProof;
	readonly verifiedIdentity: VerifiedOAuthHashes;
}

export type CompleteBindingResult =
	| { readonly kind: "SUCCESS"; readonly binding: IdentityBindingRecord }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "IDENTITY_CONFLICT" };

export type UnbindIdentityResult =
	| { readonly kind: "SUCCESS"; readonly unboundAt: Date }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "FORBIDDEN" }
	| { readonly kind: "CONFLICT" };

export interface SessionRecord {
	readonly sessionId: string;
	readonly deviceLabel: string;
	readonly platform: "ANDROID";
	readonly current: boolean;
	readonly createdAt: Date;
	readonly lastActiveAt: Date;
	readonly expiresAt: Date;
}

export type RevokeSessionResult =
	| { readonly kind: "SUCCESS"; readonly revokedAt: Date }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "CONFLICT" };

export interface DataExportDraft {
	readonly exportId: string;
	readonly includeBehaviorHistory: boolean;
}

export type DataExportStatus =
	| "QUEUED"
	| "PROCESSING"
	| "READY"
	| "FAILED"
	| "EXPIRED";

interface DataExportRecordBase {
	readonly exportId: string;
	readonly requestedAt: Date;
	readonly expiresAt: Date;
	readonly includeBehaviorHistory: boolean;
}

export type DataExportRecord =
	| (DataExportRecordBase & {
			readonly status: "QUEUED" | "PROCESSING";
	  })
	| (DataExportRecordBase & {
			readonly status: "READY";
			readonly readyAt: Date;
			readonly artifactSizeBytes: number;
			readonly artifactSha256: string;
	  })
	| (DataExportRecordBase & {
			readonly status: "FAILED";
			readonly failureCode: "GENERATION_FAILED";
	  })
	| (DataExportRecordBase & {
			readonly status: "EXPIRED";
	  });

export type QueueDataExportResult =
	| {
			readonly kind: "SUCCESS";
			readonly exportId: string;
			readonly requestedAt: Date;
			readonly expiresAt: Date;
			readonly includeBehaviorHistory: boolean;
	  }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "CONFLICT" };

export type ReadDataExportResult =
	| { readonly kind: "SUCCESS"; readonly record: DataExportRecord }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "NOT_FOUND" };

export type ReadLatestDataExportResult =
	| {
			readonly kind: "SUCCESS";
			readonly record: DataExportRecord | null;
	  }
	| { readonly kind: "INVALID_CREDENTIALS" };

export interface DataExportArtifactAuthorization {
	readonly locatorCiphertext: Buffer;
	readonly locatorKeyVersion: string;
	readonly sizeBytes: number;
	readonly sha256: string;
	readonly contentType: "application/json";
}

export type OpenDataExportArtifactResult =
	| {
			readonly kind: "SUCCESS";
			readonly artifact: DataExportArtifactAuthorization;
	  }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "NOT_AVAILABLE" };

export interface AccountDeletionDraft {
	readonly deletionId: string;
	readonly subjectHash: VersionedHash;
	readonly purgeDueAt: Date;
}

export type BeginAccountDeletionResult =
	| {
			readonly kind: "SUCCESS";
			readonly requestedAt: Date;
			readonly purgeDueAt: Date;
	  }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "CONFLICT" };

export abstract class AuthRepository {
	abstract isAvailable(): boolean;
	abstract createOtpChallenge(
		draft: OtpChallengeDraft,
	): Promise<CreateOtpChallengeResult>;
	abstract finalizeOtpDelivery(
		challengeId: string,
		outcome: "SENT" | "FAILED",
		providerReferenceHash: string | null,
		validUntil: Date | null,
	): Promise<boolean>;
	abstract findOtpProof(
		challengeId: string,
		channel: "PHONE" | "EMAIL",
		purpose: AuthOtpPurpose,
		deviceHashCandidates: readonly string[],
	): Promise<OtpProof | null>;
	abstract createOAuthState(
		draft: OAuthStateDraft,
	): Promise<CreateOAuthStateResult>;
	abstract findOAuthProof(
		stateHashCandidates: readonly VersionedHash[],
		provider: "WECHAT" | "QQ",
		purpose: AuthOAuthPurpose,
		deviceHashCandidates: readonly string[],
	): Promise<OAuthProof | null>;
	abstract authenticateAccess(
		tokenHashCandidates: readonly VersionedHash[],
		deviceHashCandidates?: readonly string[],
	): Promise<AuthenticatedSession | null>;
	abstract completeOtpLogin(
		completion: OtpLoginCompletion,
	): Promise<CompleteCredentialResult>;
	abstract claimPhoneOtpVerification(
		proof: OtpProof,
		claimHash: string,
		leaseUntil: Date,
	): Promise<boolean>;
	abstract releasePhoneOtpVerification(
		proof: OtpProof,
		claimHash: string,
	): Promise<boolean>;
	abstract completeOAuthLogin(
		completion: OAuthLoginCompletion,
	): Promise<CompleteOAuthCredentialResult>;
	abstract refreshSession(
		refreshHashCandidates: readonly VersionedHash[],
		deviceHashCandidates: readonly string[],
		draft: RefreshIssueDraft,
	): Promise<RefreshSessionResult>;
	abstract listIdentityBindings(
		session: AuthenticatedUserContext,
	): Promise<readonly IdentityBindingRecord[] | null>;
	abstract completeOtpBinding(
		completion: OtpBindingCompletion,
	): Promise<CompleteBindingResult>;
	abstract completeOAuthBinding(
		completion: OAuthBindingCompletion,
	): Promise<CompleteBindingResult>;
	abstract unbindIdentity(
		session: AuthenticatedUserContext,
		bindingId: string,
	): Promise<UnbindIdentityResult>;
	abstract listSessions(
		session: AuthenticatedUserContext,
	): Promise<readonly SessionRecord[] | null>;
	abstract revokeSession(
		session: AuthenticatedUserContext,
		sessionId: string,
	): Promise<RevokeSessionResult>;
	abstract queueDataExport(
		session: AuthenticatedUserContext,
		draft: DataExportDraft,
	): Promise<QueueDataExportResult>;
	abstract readDataExport(
		session: AuthenticatedUserContext,
		exportId: string,
	): Promise<ReadDataExportResult>;
	abstract readLatestDataExport(
		session: AuthenticatedUserContext,
	): Promise<ReadLatestDataExportResult>;
	abstract openDataExportArtifact(
		session: AuthenticatedUserContext,
		exportId: string,
	): Promise<OpenDataExportArtifactResult>;
	abstract beginAccountDeletion(
		session: AuthenticatedUserContext,
		draft: AccountDeletionDraft,
	): Promise<BeginAccountDeletionResult>;
}

@Injectable()
export class PostgresAuthRepository extends AuthRepository {
	constructor(private readonly database: DatabasePool) {
		super();
	}

	isAvailable(): boolean {
		return this.database.isEnabled();
	}

	async createOtpChallenge(
		draft: OtpChallengeDraft,
	): Promise<CreateOtpChallengeResult> {
		return this.database.withTransaction(async (transaction) => {
			for (const lockKey of [
				`destination:${draft.destinationDedup.value}`,
				`device:${draft.deviceHash}`,
				`ip:${draft.requestIpHash}`,
			].sort()) {
				await transaction.query(
					"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
					[lockKey],
				);
			}
			const resendDelayMs = Math.max(
				0,
				draft.resendAvailableAt.getTime() - draft.createdAt.getTime(),
			);
			const existing = await transaction.query<OtpExistingRow>(
				`SELECT id, masked_destination, expires_at, created_at
				 FROM public.otp_challenges
				 WHERE destination_dedup_hash = $1 AND purpose = $2 AND device_hash = $3
				   AND delivery_status = 'SENT' AND consumed_at IS NULL
				   AND expires_at > $4 AND created_at >= $5
				 ORDER BY created_at DESC LIMIT 1`,
				[
					draft.destinationDedup.value,
					draft.purpose,
					draft.deviceHash,
					draft.createdAt,
					new Date(draft.createdAt.getTime() - resendDelayMs),
				],
			);
			const existingRow = existing.rows[0];
			if (existingRow !== undefined) {
				const createdAt = asDate(existingRow.created_at);
				return Object.freeze({
					kind: "EXISTING" as const,
					challengeId: existingRow.id,
					maskedDestination: existingRow.masked_destination,
					expiresAt: asDate(existingRow.expires_at),
					resendAvailableAt: new Date(createdAt.getTime() + resendDelayMs),
				});
			}

			const counts = await transaction.query<CountRow>(
				`SELECT
				   count(*) FILTER (
				     WHERE destination_dedup_hash = $1 AND created_at >= $4
				   ) AS destination_hour_count,
				   count(*) FILTER (
				     WHERE destination_dedup_hash = $1 AND created_at >= $7
				   ) AS destination_day_count,
				   count(*) FILTER (WHERE device_hash = $2 AND created_at >= $4) AS device_count,
				   count(*) FILTER (WHERE request_ip_hash = $3 AND created_at >= $4) AS ip_count,
				   count(*) FILTER (
				     WHERE destination_dedup_hash = $1 AND created_at >= $6
				       AND (
				         ($8::text = 'PHONE' AND channel = 'PHONE'
				           AND delivery_status IN ('PENDING', 'SENT')
				           AND consumed_at IS NULL)
				         OR ($8::text = 'EMAIL' AND channel = 'EMAIL'
				           AND device_hash = $2 AND purpose = $5
				           AND delivery_status = 'PENDING')
				       )
				   ) AS pending_count,
				   min(created_at) FILTER (
				     WHERE destination_dedup_hash = $1 AND created_at >= $4
				   ) AS destination_hour_oldest,
				   min(created_at) FILTER (
				     WHERE destination_dedup_hash = $1 AND created_at >= $7
				   ) AS destination_day_oldest,
				   min(created_at) FILTER (WHERE device_hash = $2 AND created_at >= $4) AS device_oldest,
				   min(created_at) FILTER (WHERE request_ip_hash = $3 AND created_at >= $4) AS ip_oldest,
				   min(created_at) FILTER (
				     WHERE destination_dedup_hash = $1 AND created_at >= $6
				       AND (
				         ($8::text = 'PHONE' AND channel = 'PHONE'
				           AND delivery_status IN ('PENDING', 'SENT')
				           AND consumed_at IS NULL)
				         OR ($8::text = 'EMAIL' AND channel = 'EMAIL'
				           AND device_hash = $2 AND purpose = $5
				           AND delivery_status = 'PENDING')
				       )
				   ) AS pending_oldest
				 FROM public.otp_challenges WHERE created_at >= $7`,
				[
					draft.destinationDedup.value,
					draft.deviceHash,
					draft.requestIpHash,
					new Date(draft.createdAt.getTime() - 60 * 60_000),
					draft.purpose,
					new Date(draft.createdAt.getTime() - resendDelayMs),
					new Date(draft.createdAt.getTime() - 24 * 60 * 60_000),
					draft.channel,
				],
			);
			const count = counts.rows[0];
			const retryAfterMs =
				count === undefined
					? null
					: maximumTriggeredRetryAfterMs(draft.createdAt, resendDelayMs, count);
			if (retryAfterMs !== null) {
				return Object.freeze({
					kind: "RATE_LIMITED" as const,
					retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
				});
			}

			await transaction.query(
				`INSERT INTO public.otp_challenges (
				   id, channel, purpose,
				   destination_hash, destination_hash_algorithm, destination_hash_key_version,
				   destination_dedup_hash, destination_dedup_hash_algorithm,
				   destination_dedup_key_version, masked_destination,
				   operation_target_hash, target_user_id, registration_flow_reference_hash,
				   verification_method, code_hash, code_hash_algorithm, code_hash_key_version,
				   idempotency_key_hash, hash_key_version, request_ip_hash, device_hash,
				   created_at, retain_until
				 ) VALUES (
				   $1, $2, $3, $4, 'HMAC-SHA256', $5, $6, 'HMAC-SHA256', $7, $8,
				   $9, $10, $11, $12, $13, $14,
				   $15, $16, $17, $18, $19, $20, $21
				 )`,
				[
					draft.id,
					draft.channel,
					draft.purpose,
					draft.destinationLookup.value,
					draft.destinationLookup.keyVersion,
					draft.destinationDedup.value,
					draft.destinationDedup.keyVersion,
					draft.maskedDestination,
					draft.operationTargetHash,
					draft.targetUserId,
					draft.registrationFlowReferenceHash,
					draft.verificationMethod,
					draft.codeHash?.value ?? null,
					draft.codeHash === null ? null : "ARGON2ID-PEPPERED",
					draft.codeHash?.keyVersion ?? null,
					draft.idempotencyKeyHash,
					draft.hashKeyVersion,
					draft.requestIpHash,
					draft.deviceHash,
					draft.createdAt,
					draft.retainUntil,
				],
			);
			if (draft.channel === "PHONE") {
				const superseded = await transaction.query<BooleanRow>(
					"SELECT public.supersede_phone_otp_challenges_for_send($1) AS changed",
					[draft.id],
				);
				if (superseded.rows[0]?.changed !== true) {
					throw new Error("failed to prepare the PNVS send boundary");
				}
			}
			return Object.freeze({ kind: "CREATED" as const });
		});
	}

	async finalizeOtpDelivery(
		challengeId: string,
		outcome: "SENT" | "FAILED",
		providerReferenceHash: string | null,
		validUntil: Date | null,
	): Promise<boolean> {
		return this.database.withTransaction(async (transaction) => {
			const result = await transaction.query<BooleanRow>(
				"SELECT public.finalize_otp_delivery($1, $2, $3, $4) AS changed",
				[challengeId, outcome, providerReferenceHash, validUntil],
			);
			return result.rows[0]?.changed === true;
		});
	}

	async findOtpProof(
		challengeId: string,
		channel: "PHONE" | "EMAIL",
		purpose: AuthOtpPurpose,
		deviceHashCandidates: readonly string[],
	): Promise<OtpProof | null> {
		return this.database.withTransaction(async (transaction) => {
			const result = await transaction.query<OtpProofRow>(
				`SELECT id, channel, purpose, destination_dedup_hash,
				   verification_method, code_hash, code_hash_key_version,
				   operation_target_hash, target_user_id,
				   registration_flow_reference_hash, device_hash, hash_key_version
				 FROM public.otp_challenges
				 WHERE id = $1 AND channel = $2 AND purpose = $3
				   AND device_hash = ANY($4::varchar[])
				   AND delivery_status = 'SENT' AND consumed_at IS NULL
				   AND attempts < 5 AND expires_at > clock_timestamp() LIMIT 1`,
				[challengeId, channel, purpose, deviceHashCandidates],
			);
			return mapOtpProof(result.rows[0]);
		});
	}

	async createOAuthState(
		draft: OAuthStateDraft,
	): Promise<CreateOAuthStateResult> {
		return this.database.withTransaction(async (transaction) => {
			for (const lockKey of [
				`oauth-device:${draft.deviceHash}`,
				`oauth-flow:${draft.flowReferenceHash}`,
			].sort()) {
				await transaction.query(
					"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
					[lockKey],
				);
			}
			const counts = await transaction.query<{
				readonly device_count: string | number;
				readonly flow_count: string | number;
			}>(
				`SELECT
				   count(*) FILTER (WHERE device_hash = $1) AS device_count,
				   count(*) FILTER (WHERE flow_reference_hash = $2) AS flow_count
				 FROM public.oauth_states WHERE created_at >= $3`,
				[
					draft.deviceHash,
					draft.flowReferenceHash,
					new Date(draft.createdAt.getTime() - 10 * 60_000),
				],
			);
			const count = counts.rows[0];
			if (
				count !== undefined &&
				(toCount(count.device_count) >= 10 || toCount(count.flow_count) >= 10)
			) {
				return Object.freeze({
					kind: "RATE_LIMITED" as const,
					retryAfterSeconds: 60,
				});
			}
			await transaction.query(
				`INSERT INTO public.oauth_states (
				   id, provider, purpose, state_hash, state_hash_algorithm,
				   flow_reference_hash, operation_target_hash, target_user_id,
				   device_hash, hash_key_version, created_at, expires_at, retain_until
				 ) VALUES ($1, $2, $3, $4, 'HMAC-SHA256', $5, $6, $7, $8, $9, $10, $11, $12)`,
				[
					draft.id,
					draft.provider,
					draft.purpose,
					draft.stateHash.value,
					draft.flowReferenceHash,
					draft.operationTargetHash,
					draft.targetUserId,
					draft.deviceHash,
					draft.stateHash.keyVersion,
					draft.createdAt,
					draft.expiresAt,
					draft.retainUntil,
				],
			);
			return Object.freeze({ kind: "CREATED" as const });
		});
	}

	async findOAuthProof(
		stateHashCandidates: readonly VersionedHash[],
		provider: "WECHAT" | "QQ",
		purpose: AuthOAuthPurpose,
		deviceHashCandidates: readonly string[],
	): Promise<OAuthProof | null> {
		return this.database.withTransaction(async (transaction) => {
			const [hashes, versions] = hashArrays(stateHashCandidates);
			const result = await transaction.query<OAuthProofRow>(
				`SELECT oauth.id, oauth.provider, oauth.purpose, oauth.flow_reference_hash,
				   oauth.operation_target_hash, oauth.target_user_id,
				   oauth.device_hash, oauth.hash_key_version
				 FROM public.oauth_states AS oauth
				 JOIN unnest($1::varchar[], $2::varchar[]) AS candidate(hash, version)
				   ON candidate.hash = oauth.state_hash AND candidate.version = oauth.hash_key_version
				 WHERE oauth.provider = $3 AND oauth.purpose = $4
				   AND oauth.device_hash = ANY($5::varchar[])
				   AND oauth.consumed_at IS NULL AND oauth.expires_at > clock_timestamp()
				 LIMIT 1`,
				[hashes, versions, provider, purpose, deviceHashCandidates],
			);
			return mapOAuthProof(result.rows[0]);
		});
	}

	async authenticateAccess(
		tokenHashCandidates: readonly VersionedHash[],
		deviceHashCandidates?: readonly string[],
	): Promise<AuthenticatedSession | null> {
		return this.database.withTransaction(async (transaction) => {
			const [hashes, versions] = hashArrays(tokenHashCandidates);
			const result = await transaction.query<AccessSessionRow>(
				`SELECT family.user_id, family.id AS session_id,
				   family.device_hash, family.hash_key_version
				 FROM public.auth_access_tokens AS access
				 JOIN unnest($1::varchar[], $2::varchar[]) AS candidate(hash, version)
				   ON candidate.hash = access.token_hash
				  AND candidate.version = access.token_hash_key_version
				 JOIN public.auth_session_families AS family ON family.id = access.session_family_id
				 JOIN public.users AS account_user ON account_user.id = family.user_id
				 WHERE access.revoked_at IS NULL AND access.expires_at > clock_timestamp()
				   AND family.status = 'ACTIVE' AND family.refresh_expires_at > clock_timestamp()
				   AND account_user.status = 'ACTIVE'
				   AND ($3::varchar[] IS NULL OR family.device_hash = ANY($3::varchar[]))
				 LIMIT 1`,
				[hashes, versions, deviceHashCandidates ?? null],
			);
			const row = result.rows[0];
			return row === undefined
				? null
				: Object.freeze({
						userId: row.user_id,
						sessionId: row.session_id,
						deviceHash: row.device_hash,
						hashKeyVersion: row.hash_key_version,
					});
		});
	}

	async completeOtpLogin(
		completion: OtpLoginCompletion,
	): Promise<CompleteCredentialResult> {
		return this.database.withTransaction(async (transaction) => {
			const consumed =
				completion.proof.channel === "PHONE"
					? completion.verificationClaimHash !== null &&
						(await completePhoneOtpVerification(
							transaction,
							completion.proof,
							completion.verificationClaimHash,
							completion.verificationSucceeded,
						))
					: await recordOtpAttempt(
							transaction,
							completion.proof,
							completion.verificationSucceeded,
						);
			if (!consumed)
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			if (completion.session === null) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			let userId = await findActiveIdentityUser(
				transaction,
				completion.proof.channel,
				completion.proof.destinationDedupHash,
			);
			if (
				userId === null &&
				completion.proof.channel === "PHONE" &&
				completion.proof.purpose === "REGISTER" &&
				completion.newUserId !== null
			) {
				const registered = await transaction.query<BooleanRow>(
					"SELECT public.register_phone_account_from_consumed_otp($1, $2, $3) AS changed",
					[
						completion.newUserId,
						completion.proof.id,
						completion.proof.deviceHash,
					],
				);
				if (registered.rows[0]?.changed !== true) {
					// A different valid REGISTER challenge for the same phone can win the
					// unique binding race while this transaction is waiting. Re-read after
					// the failed insert so both callers keep the same login-or-register
					// semantics without exposing whether the account existed beforehand.
					userId = await findActiveIdentityUser(
						transaction,
						"PHONE",
						completion.proof.destinationDedupHash,
					);
					if (userId === null) {
						return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
					}
				} else {
					userId = completion.newUserId;
				}
			}
			if (userId === null) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			await insertSession(transaction, userId, completion.session);
			return Object.freeze({
				kind: "SUCCESS" as const,
				userId,
				sessionId: completion.session.sessionId,
			});
		});
	}

	async claimPhoneOtpVerification(
		proof: OtpProof,
		claimHash: string,
		leaseUntil: Date,
	): Promise<boolean> {
		return this.database.withTransaction(async (transaction) => {
			const result = await transaction.query<BooleanRow>(
				"SELECT public.claim_otp_verification_lease($1, $2, $3, $4, $5, $6, $7) AS changed",
				[
					proof.id,
					proof.purpose,
					proof.targetUserId,
					proof.operationTargetHash,
					proof.deviceHash,
					claimHash,
					leaseUntil,
				],
			);
			return result.rows[0]?.changed === true;
		});
	}

	async releasePhoneOtpVerification(
		proof: OtpProof,
		claimHash: string,
	): Promise<boolean> {
		return this.database.withTransaction(async (transaction) => {
			const result = await transaction.query<BooleanRow>(
				"SELECT public.release_otp_verification_lease($1, $2) AS changed",
				[proof.id, claimHash],
			);
			return result.rows[0]?.changed === true;
		});
	}

	async completeOAuthLogin(
		completion: OAuthLoginCompletion,
	): Promise<CompleteOAuthCredentialResult> {
		return this.database.withTransaction(async (transaction) => {
			const consumed = await consumeOAuth(
				transaction,
				completion.proof,
				completion.verifiedIdentity,
			);
			if (!consumed)
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			const identityOwner = await findActiveOAuthIdentityUser(
				transaction,
				completion.proof.provider,
				completion.verifiedIdentity.lookup.value,
				completion.verifiedIdentity.dedup.value,
			);
			if (identityOwner.kind === "CONFLICT") {
				return Object.freeze({ kind: "IDENTITY_CONFLICT" as const });
			}
			if (identityOwner.kind === "NONE")
				return Object.freeze({ kind: "IDENTITY_NOT_BOUND" as const });
			const userId = identityOwner.userId;
			if (
				completion.proof.provider === "WECHAT" &&
				!(await recordWechatUnionAliasFromConsumedState(
					transaction,
					completion.proof.id,
					identityOwner.bindingId,
				))
			) {
				return Object.freeze({ kind: "IDENTITY_CONFLICT" as const });
			}
			await insertSession(transaction, userId, completion.session);
			return Object.freeze({
				kind: "SUCCESS" as const,
				userId,
				sessionId: completion.session.sessionId,
			});
		});
	}

	async refreshSession(
		refreshHashCandidates: readonly VersionedHash[],
		deviceHashCandidates: readonly string[],
		draft: RefreshIssueDraft,
	): Promise<RefreshSessionResult> {
		return this.database.withTransaction(async (transaction) => {
			const [hashes, versions] = hashArrays(refreshHashCandidates);
			const result = await transaction.query<RefreshCredentialRow>(
				`SELECT credential.id AS credential_id, credential.session_family_id,
				   credential.generation, credential.consumed_at, credential.replay_detected_at,
				   credential.expires_at AS credential_expires_at,
				   family.status AS family_status, family.refresh_expires_at,
				   family.device_hash, family.user_id, account_user.status AS user_status
				 FROM public.auth_refresh_credentials AS credential
				 JOIN unnest($1::varchar[], $2::varchar[]) AS candidate(hash, version)
				   ON candidate.hash = credential.token_hash
				  AND candidate.version = credential.token_hash_key_version
				 JOIN public.auth_session_families AS family ON family.id = credential.session_family_id
				 JOIN public.users AS account_user ON account_user.id = family.user_id
				 WHERE family.device_hash = ANY($3::varchar[])
				 LIMIT 1`,
				[hashes, versions, deviceHashCandidates],
			);
			const row = result.rows[0];
			if (row === undefined) return Object.freeze({ kind: "INVALID" as const });
			await transaction.query(
				"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
				[`refresh:${row.credential_id}`],
			);
			const refreshed = await transaction.query<RefreshCredentialRow>(
				`SELECT credential.id AS credential_id, credential.session_family_id,
				   credential.generation, credential.consumed_at, credential.replay_detected_at,
				   credential.expires_at AS credential_expires_at,
				   family.status AS family_status, family.refresh_expires_at,
				   family.device_hash, family.user_id, account_user.status AS user_status
				 FROM public.auth_refresh_credentials AS credential
				 JOIN public.auth_session_families AS family ON family.id = credential.session_family_id
				 JOIN public.users AS account_user ON account_user.id = family.user_id
				 WHERE credential.id = $1 AND family.device_hash = ANY($2::varchar[])
				 LIMIT 1`,
				[row.credential_id, deviceHashCandidates],
			);
			const current = refreshed.rows[0];
			if (current === undefined)
				return Object.freeze({ kind: "INVALID" as const });
			if (current.consumed_at !== null) {
				if (current.replay_detected_at === null) {
					await transaction.query(
						"SELECT public.mark_auth_refresh_replay($1, $2)",
						[current.session_family_id, current.credential_id],
					);
				}
				return Object.freeze({ kind: "REPLAY" as const });
			}
			const now = draft.issuedAt.getTime();
			const refreshExpiresAt = asDate(current.refresh_expires_at);
			if (
				asDate(current.credential_expires_at).getTime() <= now ||
				refreshExpiresAt.getTime() <= now ||
				current.family_status !== "ACTIVE" ||
				current.user_status !== "ACTIVE"
			) {
				return Object.freeze({ kind: "INVALID" as const });
			}
			const accessExpiresAt = new Date(
				Math.min(draft.accessExpiresAt.getTime(), refreshExpiresAt.getTime()),
			);
			if (accessExpiresAt.getTime() <= now) {
				return Object.freeze({ kind: "INVALID" as const });
			}
			await transaction.query(
				`INSERT INTO public.auth_refresh_credentials (
				   id, session_family_id, generation, token_hash,
				   token_hash_algorithm, token_hash_key_version, issued_at, expires_at
				 ) VALUES ($1, $2, $3, $4, 'HMAC-SHA256', $5, $6, $7)`,
				[
					draft.refreshCredentialId,
					current.session_family_id,
					current.generation + 1,
					draft.refreshTokenHash.value,
					draft.refreshTokenHash.keyVersion,
					draft.issuedAt,
					refreshExpiresAt,
				],
			);
			const rotated = await transaction.query<BooleanRow>(
				"SELECT public.rotate_auth_refresh_credential($1, $2, $3) AS changed",
				[
					current.credential_id,
					current.session_family_id,
					draft.refreshCredentialId,
				],
			);
			if (rotated.rows[0]?.changed !== true) {
				throw new Error("refresh transition rejected");
			}
			await insertAccessToken(
				transaction,
				current.session_family_id,
				draft.accessCredentialId,
				draft.accessTokenHash,
				draft.issuedAt,
				accessExpiresAt,
				new Date(accessExpiresAt.getTime() + 24 * 60 * 60_000),
			);
			await transaction.query(
				`UPDATE public.auth_session_families
				 SET last_seen_at = GREATEST(last_seen_at, $2)
				 WHERE id = $1 AND status = 'ACTIVE'`,
				[current.session_family_id, draft.issuedAt],
			);
			return Object.freeze({
				kind: "SUCCESS" as const,
				userId: current.user_id,
				sessionId: current.session_family_id,
				accessExpiresAt,
				refreshExpiresAt,
			});
		});
	}

	async listIdentityBindings(
		session: AuthenticatedUserContext,
	): Promise<readonly IdentityBindingRecord[] | null> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session))) return null;
			const result = await transaction.query<IdentityBindingRow>(
				`SELECT id, identity_type, masked_display_hint, is_primary,
				   verified_at, revoked_at
				 FROM public.identity_bindings
				 WHERE user_id = $1 AND revoked_at IS NULL
				   AND identity_type IN ('PHONE', 'EMAIL', 'WECHAT', 'QQ')
				 ORDER BY is_primary DESC, verified_at ASC, id ASC
				 LIMIT 8`,
				[session.userId],
			);
			return Object.freeze(result.rows.map(mapIdentityBinding));
		});
	}

	async completeOtpBinding(
		completion: OtpBindingCompletion,
	): Promise<CompleteBindingResult> {
		return this.database.withTransaction(async (transaction) => {
			if (
				completion.proof.channel !== "EMAIL" ||
				completion.proof.purpose !== "BIND" ||
				completion.proof.targetUserId !== completion.session.userId ||
				completion.proof.operationTargetHash === null ||
				completion.proof.deviceHash !== completion.session.deviceHash ||
				!(await hasActiveSession(transaction, completion.session, true))
			) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			if (!completion.verificationSucceeded) {
				await recordOtpAttempt(transaction, completion.proof, false);
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}

			// Conflict checks intentionally run only after the caller has proved
			// possession of the emailed code, but before the challenge is consumed.
			// A conflict response must never leave a valid proof consumed-but-unbound.
			const conflict = await findIdentityOwner(
				transaction,
				"EMAIL",
				completion.proof.destinationDedupHash,
			);
			if (
				conflict !== null &&
				(conflict.userId !== completion.session.userId ||
					conflict.revokedAt === null)
			) {
				return Object.freeze({ kind: "IDENTITY_CONFLICT" as const });
			}
			if (
				await hasActiveEmailIdentity(transaction, completion.session.userId)
			) {
				return Object.freeze({ kind: "IDENTITY_CONFLICT" as const });
			}

			const consumed = await recordOtpAttempt(
				transaction,
				completion.proof,
				true,
			);
			if (!consumed) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const bound = await transaction.query<UuidRow>(
				"SELECT public.bind_email_identity_from_consumed_otp($1, $2, $3, $4) AS id",
				[
					completion.session.userId,
					completion.proof.id,
					completion.proof.operationTargetHash,
					completion.proof.deviceHash,
				],
			);
			const bindingId = bound.rows[0]?.id;
			if (bindingId === undefined || bindingId === null) {
				// Returning here would commit the consumed challenge. Throw so the
				// transaction rolls the consume back when a concurrent conflict wins.
				throw new Error("verified email binding did not complete");
			}
			const binding = await findIdentityBinding(
				transaction,
				completion.session.userId,
				bindingId,
			);
			if (binding === null) throw new Error("bound identity is unavailable");
			return Object.freeze({ kind: "SUCCESS" as const, binding });
		});
	}

	async completeOAuthBinding(
		completion: OAuthBindingCompletion,
	): Promise<CompleteBindingResult> {
		return this.database.withTransaction(async (transaction) => {
			if (
				(completion.proof.provider !== "QQ" &&
					completion.proof.provider !== "WECHAT") ||
				completion.proof.purpose !== "BIND" ||
				completion.proof.targetUserId !== completion.session.userId ||
				completion.proof.operationTargetHash === null ||
				completion.proof.deviceHash !== completion.session.deviceHash ||
				!(await hasActiveSession(transaction, completion.session, true))
			) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const consumed = await consumeOAuth(
				transaction,
				completion.proof,
				completion.verifiedIdentity,
			);
			if (!consumed) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const conflict = await findIdentityOwner(
				transaction,
				completion.proof.provider,
				completion.verifiedIdentity.dedup.value,
			);
			const lookupConflict = await findIdentityLookupOwner(
				transaction,
				completion.proof.provider,
				completion.verifiedIdentity.lookup.value,
			);
			if (
				(conflict !== null && conflict.userId !== completion.session.userId) ||
				(lookupConflict !== null &&
					lookupConflict.userId !== completion.session.userId) ||
				(conflict !== null &&
					lookupConflict !== null &&
					conflict.userId !== lookupConflict.userId)
			) {
				return Object.freeze({ kind: "IDENTITY_CONFLICT" as const });
			}
			const bindingFunction =
				completion.proof.provider === "WECHAT"
					? "public.bind_oauth_identity_with_wechat_union_from_consumed_state"
					: "public.bind_oauth_identity_from_consumed_state";
			const bound = await transaction.query<UuidRow>(
				`SELECT ${bindingFunction}($1, $2, $3, $4, $5, $6) AS id`,
				[
					completion.session.userId,
					completion.proof.id,
					completion.proof.provider,
					completion.proof.flowReferenceHash,
					completion.proof.operationTargetHash,
					completion.proof.deviceHash,
				],
			);
			const bindingId = bound.rows[0]?.id;
			if (bindingId === undefined || bindingId === null) {
				return Object.freeze({ kind: "IDENTITY_CONFLICT" as const });
			}
			const binding = await findIdentityBinding(
				transaction,
				completion.session.userId,
				bindingId,
			);
			if (binding === null) throw new Error("bound identity is unavailable");
			return Object.freeze({ kind: "SUCCESS" as const, binding });
		});
	}

	async unbindIdentity(
		session: AuthenticatedUserContext,
		bindingId: string,
	): Promise<UnbindIdentityResult> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session, true))) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const binding = await findIdentityBinding(
				transaction,
				session.userId,
				bindingId,
			);
			if (binding === null) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			if (
				binding.primary ||
				!["EMAIL", "WECHAT", "QQ"].includes(binding.type)
			) {
				return Object.freeze({ kind: "FORBIDDEN" as const });
			}
			if (binding.revokedAt !== null) {
				return Object.freeze({
					kind: "SUCCESS" as const,
					unboundAt: binding.revokedAt,
				});
			}
			const revoked = await transaction.query<BooleanRow>(
				"SELECT public.revoke_non_primary_identity_binding($1, $2) AS changed",
				[bindingId, session.userId],
			);
			if (revoked.rows[0]?.changed !== true) {
				const refreshed = await findIdentityBinding(
					transaction,
					session.userId,
					bindingId,
				);
				if (
					refreshed?.revokedAt !== null &&
					refreshed?.revokedAt !== undefined
				) {
					return Object.freeze({
						kind: "SUCCESS" as const,
						unboundAt: refreshed.revokedAt,
					});
				}
				return Object.freeze({ kind: "CONFLICT" as const });
			}
			const refreshed = await findIdentityBinding(
				transaction,
				session.userId,
				bindingId,
			);
			if (refreshed?.revokedAt === null || refreshed === null) {
				throw new Error("identity revocation evidence is unavailable");
			}
			return Object.freeze({
				kind: "SUCCESS" as const,
				unboundAt: refreshed.revokedAt,
			});
		});
	}

	async listSessions(
		session: AuthenticatedUserContext,
	): Promise<readonly SessionRecord[] | null> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session))) return null;
			const result = await transaction.query<SessionRow>(
				`SELECT id, device_label, platform, created_at, last_seen_at,
				   refresh_expires_at, status, revoked_at
				 FROM public.auth_session_families
				 WHERE user_id = $1 AND platform = 'ANDROID' AND status = 'ACTIVE'
				   AND refresh_expires_at > clock_timestamp()
				 ORDER BY (id = $2) DESC, last_seen_at DESC, id ASC
				 LIMIT 50`,
				[session.userId, session.sessionId],
			);
			return Object.freeze(
				result.rows.map((row) =>
					Object.freeze({
						sessionId: row.id,
						deviceLabel: row.device_label,
						platform: row.platform,
						current: row.id === session.sessionId,
						createdAt: asDate(row.created_at),
						lastActiveAt: asDate(row.last_seen_at),
						expiresAt: asDate(row.refresh_expires_at),
					}),
				),
			);
		});
	}

	async revokeSession(
		session: AuthenticatedUserContext,
		sessionId: string,
	): Promise<RevokeSessionResult> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session, true))) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const target = await transaction.query<SessionRow>(
				`SELECT id, device_label, platform, created_at, last_seen_at,
				   refresh_expires_at, status, revoked_at
				 FROM public.auth_session_families
				 WHERE id = $1 AND user_id = $2 AND platform = 'ANDROID'
				 FOR UPDATE`,
				[sessionId, session.userId],
			);
			const targetRow = target.rows[0];
			if (targetRow === undefined) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			if (targetRow.status !== "ACTIVE") {
				return targetRow.revoked_at === null
					? Object.freeze({ kind: "CONFLICT" as const })
					: Object.freeze({
							kind: "SUCCESS" as const,
							revokedAt: asDate(targetRow.revoked_at),
						});
			}
			const revoked = await transaction.query<TimestampRow>(
				`UPDATE public.auth_session_families
				 SET status = 'REVOKED', revoked_at = clock_timestamp()
				 WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'
				 RETURNING revoked_at AS occurred_at`,
				[sessionId, session.userId],
			);
			const occurredAt = revoked.rows[0]?.occurred_at;
			if (occurredAt === undefined) {
				return Object.freeze({ kind: "CONFLICT" as const });
			}
			await transaction.query(
				`UPDATE public.auth_access_tokens
				 SET revoked_at = $2
				 WHERE session_family_id = $1 AND revoked_at IS NULL`,
				[sessionId, occurredAt],
			);
			return Object.freeze({
				kind: "SUCCESS" as const,
				revokedAt: asDate(occurredAt),
			});
		});
	}

	async queueDataExport(
		session: AuthenticatedUserContext,
		draft: DataExportDraft,
	): Promise<QueueDataExportResult> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session, true))) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const queued = await transaction.query<ExportQueueRow>(
				`SELECT outcome, export_id, export_status, requested_at, ready_at,
				        expires_at, include_behavior_history, failure_code,
				        artifact_size_bytes, artifact_sha256
				 FROM public.app_queue_data_export($1::uuid, $2::uuid, $3::boolean)`,
				[session.userId, draft.exportId, draft.includeBehaviorHistory],
			);
			const row = queued.rows[0];
			if (row === undefined)
				throw new Error("data export queue returned no row");
			if (row.outcome === "CONFLICT") {
				return Object.freeze({ kind: "CONFLICT" as const });
			}
			if (row.outcome === "INVALID_USER") {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			if (row.outcome !== "CREATED" && row.outcome !== "REPLAY") {
				throw new Error("data export queue returned an unknown outcome");
			}
			if (
				row.export_id === null ||
				row.export_status !== "QUEUED" ||
				row.requested_at === null ||
				row.expires_at === null ||
				row.include_behavior_history === null
			) {
				throw new Error("data export queue returned an invalid row");
			}
			return Object.freeze({
				kind: "SUCCESS" as const,
				exportId: row.export_id,
				requestedAt: asDate(row.requested_at),
				expiresAt: asDate(row.expires_at),
				includeBehaviorHistory: row.include_behavior_history,
			});
		});
	}

	async readDataExport(
		session: AuthenticatedUserContext,
		exportId: string,
	): Promise<ReadDataExportResult> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session, true))) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const result = await transaction.query<ExportStatusRow>(
				`SELECT export_id, export_status, requested_at, ready_at, expires_at,
				        include_behavior_history, failure_code, artifact_size_bytes,
				        artifact_sha256
				 FROM public.app_get_data_export_status($1::uuid, $2::uuid)`,
				[session.userId, exportId],
			);
			const row = result.rows[0];
			return row === undefined
				? Object.freeze({ kind: "NOT_FOUND" as const })
				: Object.freeze({
						kind: "SUCCESS" as const,
						record: mapDataExportRecord(row),
					});
		});
	}

	async readLatestDataExport(
		session: AuthenticatedUserContext,
	): Promise<ReadLatestDataExportResult> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session, true))) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const result = await transaction.query<ExportStatusRow>(
				`SELECT export_id, export_status, requested_at, ready_at, expires_at,
				        include_behavior_history, failure_code, artifact_size_bytes,
				        artifact_sha256
				 FROM public.app_get_latest_data_export_status($1::uuid)`,
				[session.userId],
			);
			const row = result.rows[0];
			return Object.freeze({
				kind: "SUCCESS" as const,
				record: row === undefined ? null : mapDataExportRecord(row),
			});
		});
	}

	async openDataExportArtifact(
		session: AuthenticatedUserContext,
		exportId: string,
	): Promise<OpenDataExportArtifactResult> {
		return this.database.withTransaction(async (transaction) => {
			if (!(await hasActiveSession(transaction, session, true))) {
				return Object.freeze({ kind: "INVALID_CREDENTIALS" as const });
			}
			const result = await transaction.query<ExportArtifactRow>(
				`SELECT artifact_locator_ciphertext, artifact_encryption_key_version,
				        artifact_size_bytes, artifact_sha256, artifact_content_type
				 FROM public.app_open_data_export_artifact($1::uuid, $2::uuid)`,
				[session.userId, exportId],
			);
			const row = result.rows[0];
			if (row === undefined) {
				return Object.freeze({ kind: "NOT_AVAILABLE" as const });
			}
			if (
				row.artifact_content_type !== "application/json" ||
				!Buffer.isBuffer(row.artifact_locator_ciphertext) ||
				row.artifact_locator_ciphertext.byteLength < 1 ||
				row.artifact_locator_ciphertext.byteLength > 4_096 ||
				!/^[A-Za-z0-9_.-]{1,64}$/u.test(row.artifact_encryption_key_version) ||
				!/^[0-9a-f]{64}$/u.test(row.artifact_sha256)
			) {
				throw new Error("data export artifact metadata is invalid");
			}
			return Object.freeze({
				kind: "SUCCESS" as const,
				artifact: Object.freeze({
					locatorCiphertext: Buffer.from(row.artifact_locator_ciphertext),
					locatorKeyVersion: row.artifact_encryption_key_version,
					sizeBytes: asSafeNonNegativeInteger(row.artifact_size_bytes),
					sha256: row.artifact_sha256,
					contentType: "application/json" as const,
				}),
			});
		});
	}

	async beginAccountDeletion(
		session: AuthenticatedUserContext,
		draft: AccountDeletionDraft,
	): Promise<BeginAccountDeletionResult> {
		return this.database.withTransaction(async (transaction) => {
			await transaction.query(
				"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
				[`account-deletion:${session.userId}`],
			);
			if (!(await hasActiveSession(transaction, session, true))) {
				const pending = await transaction.query<UuidRow>(
					`SELECT id FROM public.account_deletion_jobs
					 WHERE user_id = $1 AND status IN ('PENDING', 'PROCESSING', 'FAILED')
					 LIMIT 1`,
					[session.userId],
				);
				return pending.rows[0]?.id === undefined
					? Object.freeze({ kind: "INVALID_CREDENTIALS" as const })
					: Object.freeze({ kind: "CONFLICT" as const });
			}
			const begun = await transaction.query<BooleanRow>(
				"SELECT public.begin_account_deletion($1, $2, $3, $4, $5) AS changed",
				[
					session.userId,
					draft.deletionId,
					draft.subjectHash.value,
					draft.subjectHash.keyVersion,
					draft.purgeDueAt,
				],
			);
			if (begun.rows[0]?.changed !== true) {
				return Object.freeze({ kind: "CONFLICT" as const });
			}
			const job = await transaction.query<DeletionJobRow>(
				`SELECT requested_at, purge_due_at
				 FROM public.account_deletion_jobs
				 WHERE id = $1 AND user_id = $2 LIMIT 1`,
				[draft.deletionId, session.userId],
			);
			const row = job.rows[0];
			if (row === undefined) throw new Error("deletion job is unavailable");
			return Object.freeze({
				kind: "SUCCESS" as const,
				requestedAt: asDate(row.requested_at),
				purgeDueAt: asDate(row.purge_due_at),
			});
		});
	}
}

async function hasActiveSession(
	transaction: DatabaseTransaction,
	session: AuthenticatedUserContext,
	lock = false,
): Promise<boolean> {
	const result = await transaction.query<UuidRow>(
		`SELECT family.id
		 FROM public.auth_session_families AS family
		 JOIN public.users AS account_user ON account_user.id = family.user_id
		 WHERE family.id = $1 AND family.user_id = $2 AND family.device_hash = $3
		   AND family.status = 'ACTIVE'
		   AND family.refresh_expires_at > clock_timestamp()
		   AND account_user.status = 'ACTIVE'
		 LIMIT 1${lock ? " FOR UPDATE OF family" : ""}`,
		[session.sessionId, session.userId, session.deviceHash],
	);
	return result.rows[0]?.id !== undefined;
}

async function findIdentityOwner(
	transaction: DatabaseTransaction,
	type: "EMAIL" | "WECHAT" | "QQ",
	dedupHash: string,
): Promise<{
	readonly userId: string;
	readonly revokedAt: Date | null;
} | null> {
	const result = await transaction.query<IdentityOwnerRow>(
		`SELECT user_id, revoked_at
		 FROM public.identity_bindings
		 WHERE identity_type = $1 AND dedup_hash = $2
		 LIMIT 1`,
		[type, dedupHash],
	);
	const row = result.rows[0];
	return row === undefined
		? null
		: Object.freeze({
				userId: row.user_id,
				revokedAt: row.revoked_at === null ? null : asDate(row.revoked_at),
			});
}

async function hasActiveEmailIdentity(
	transaction: DatabaseTransaction,
	userId: string,
): Promise<boolean> {
	const result = await transaction.query<UuidRow>(
		`SELECT id
		 FROM public.identity_bindings
		 WHERE user_id = $1 AND identity_type = 'EMAIL' AND revoked_at IS NULL
		 LIMIT 1`,
		[userId],
	);
	return result.rows[0]?.id !== undefined;
}

async function findIdentityLookupOwner(
	transaction: DatabaseTransaction,
	type: "WECHAT" | "QQ",
	lookupHash: string,
): Promise<{
	readonly userId: string;
	readonly revokedAt: Date | null;
} | null> {
	const result = await transaction.query<IdentityOwnerRow>(
		`SELECT user_id, revoked_at
		 FROM public.identity_bindings
		 WHERE identity_type = $1 AND lookup_hash = $2
		 LIMIT 1`,
		[type, lookupHash],
	);
	const row = result.rows[0];
	return row === undefined
		? null
		: Object.freeze({
				userId: row.user_id,
				revokedAt: row.revoked_at === null ? null : asDate(row.revoked_at),
			});
}

type ActiveOAuthIdentityOwner =
	| { readonly kind: "NONE" }
	| {
			readonly kind: "OWNER";
			readonly userId: string;
			readonly bindingId: string;
	  }
	| { readonly kind: "CONFLICT" };

async function findActiveOAuthIdentityUser(
	transaction: DatabaseTransaction,
	type: "WECHAT" | "QQ",
	lookupHash: string,
	dedupHash: string,
): Promise<ActiveOAuthIdentityOwner> {
	const result = await transaction.query<
		OAuthOwnerRow & { readonly id: string }
	>(
		`SELECT binding.id, binding.user_id, binding.revoked_at,
		   account_user.status AS user_status
		 FROM public.identity_bindings AS binding
		 JOIN public.users AS account_user ON account_user.id = binding.user_id
		 WHERE binding.identity_type = $1
		   AND (binding.lookup_hash = $2 OR binding.dedup_hash = $3)
		 LIMIT 3`,
		[type, lookupHash, dedupHash],
	);
	const owners = new Set(result.rows.map((row) => row.user_id));
	if (owners.size > 1) return Object.freeze({ kind: "CONFLICT" as const });
	const owner = result.rows[0]?.user_id;
	if (
		owner === undefined ||
		!result.rows.some(
			(row) =>
				row.user_id === owner &&
				row.revoked_at === null &&
				row.user_status === "ACTIVE",
		)
	) {
		return Object.freeze({ kind: "NONE" as const });
	}
	const bindingId = result.rows.find(
		(row) =>
			row.user_id === owner &&
			row.revoked_at === null &&
			row.user_status === "ACTIVE",
	)?.id;
	if (bindingId === undefined)
		return Object.freeze({ kind: "CONFLICT" as const });
	return Object.freeze({ kind: "OWNER" as const, userId: owner, bindingId });
}

async function findIdentityBinding(
	transaction: DatabaseTransaction,
	userId: string,
	bindingId: string,
): Promise<IdentityBindingRecord | null> {
	const result = await transaction.query<IdentityBindingRow>(
		`SELECT id, identity_type, masked_display_hint, is_primary,
		   verified_at, revoked_at
		 FROM public.identity_bindings
		 WHERE id = $1 AND user_id = $2
		   AND identity_type IN ('PHONE', 'EMAIL', 'WECHAT', 'QQ')
		 LIMIT 1`,
		[bindingId, userId],
	);
	const row = result.rows[0];
	return row === undefined ? null : mapIdentityBinding(row);
}

function mapIdentityBinding(row: IdentityBindingRow): IdentityBindingRecord {
	return Object.freeze({
		bindingId: row.id,
		type: row.identity_type,
		maskedValue: row.masked_display_hint,
		boundAt: asDate(row.verified_at),
		primary: row.is_primary,
		canUnbind:
			!row.is_primary &&
			row.revoked_at === null &&
			(row.identity_type === "EMAIL" ||
				row.identity_type === "WECHAT" ||
				row.identity_type === "QQ"),
		revokedAt: row.revoked_at === null ? null : asDate(row.revoked_at),
	});
}

async function recordOtpAttempt(
	transaction: DatabaseTransaction,
	proof: OtpProof,
	verificationSucceeded: boolean,
): Promise<boolean> {
	const result = await transaction.query<BooleanRow>(
		"SELECT public.record_otp_verification_attempt($1, $2, $3, $4, $5, $6) AS changed",
		[
			proof.id,
			proof.purpose,
			proof.targetUserId,
			proof.operationTargetHash,
			proof.deviceHash,
			verificationSucceeded,
		],
	);
	return result.rows[0]?.changed === true;
}

async function completePhoneOtpVerification(
	transaction: DatabaseTransaction,
	proof: OtpProof,
	claimHash: string,
	verificationSucceeded: boolean,
): Promise<boolean> {
	const result = await transaction.query<BooleanRow>(
		"SELECT public.complete_otp_verification_lease($1, $2, $3, $4, $5, $6, $7) AS changed",
		[
			proof.id,
			proof.purpose,
			proof.targetUserId,
			proof.operationTargetHash,
			proof.deviceHash,
			claimHash,
			verificationSucceeded,
		],
	);
	return result.rows[0]?.changed === true;
}

async function consumeOAuth(
	transaction: DatabaseTransaction,
	proof: OAuthProof,
	hashes: VerifiedOAuthHashes,
): Promise<boolean> {
	if (proof.provider === "QQ") {
		const result = await transaction.query<BooleanRow>(
			"SELECT public.consume_oauth_state($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS changed",
			[
				proof.id,
				proof.provider,
				proof.purpose,
				proof.flowReferenceHash,
				proof.operationTargetHash,
				proof.targetUserId,
				proof.deviceHash,
				hashes.lookup.value,
				hashes.lookup.keyVersion,
				hashes.dedup.value,
				hashes.dedup.keyVersion,
			],
		);
		return result.rows[0]?.changed === true;
	}
	const result = await transaction.query<BooleanRow>(
		"SELECT public.consume_oauth_state_with_wechat_union($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS changed",
		[
			proof.id,
			proof.provider,
			proof.purpose,
			proof.flowReferenceHash,
			proof.operationTargetHash,
			proof.targetUserId,
			proof.deviceHash,
			hashes.lookup.value,
			hashes.lookup.keyVersion,
			hashes.dedup.value,
			hashes.dedup.keyVersion,
			hashes.wechatUnionAlias?.realmId ?? null,
			hashes.wechatUnionAlias?.hash.value ?? null,
			hashes.wechatUnionAlias?.hash.keyVersion ?? null,
		],
	);
	return result.rows[0]?.changed === true;
}

async function recordWechatUnionAliasFromConsumedState(
	transaction: DatabaseTransaction,
	oauthStateId: string,
	identityBindingId: string,
): Promise<boolean> {
	const result = await transaction.query<BooleanRow>(
		"SELECT public.record_wechat_union_alias_from_consumed_state($1, $2) AS changed",
		[oauthStateId, identityBindingId],
	);
	return result.rows[0]?.changed === true;
}

async function findActiveIdentityUser(
	transaction: DatabaseTransaction,
	identityType: "PHONE" | "EMAIL" | "WECHAT" | "QQ",
	dedupHash: string,
): Promise<string | null> {
	const result = await transaction.query<UserRow>(
		`SELECT binding.user_id
		 FROM public.identity_bindings AS binding
		 JOIN public.users AS account_user ON account_user.id = binding.user_id
		 WHERE binding.identity_type = $1 AND binding.dedup_hash = $2
		   AND binding.revoked_at IS NULL AND account_user.status = 'ACTIVE'
		 LIMIT 1`,
		[identityType, dedupHash],
	);
	return result.rows[0]?.user_id ?? null;
}

async function insertSession(
	transaction: DatabaseTransaction,
	userId: string,
	draft: SessionIssueDraft,
): Promise<void> {
	await transaction.query(
		`INSERT INTO public.auth_session_families (
		   id, user_id, device_label, platform, device_hash, last_ip_hash,
		   hash_key_version, created_at, last_seen_at,
		   refresh_expires_at, retain_until
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)`,
		[
			draft.sessionId,
			userId,
			draft.device.label,
			draft.device.platform,
			draft.deviceHash,
			draft.requestIpHash,
			draft.hashKeyVersion,
			draft.issuedAt,
			draft.refreshExpiresAt,
			draft.sessionRetainUntil,
		],
	);
	await transaction.query(
		`INSERT INTO public.auth_refresh_credentials (
		   id, session_family_id, generation, token_hash,
		   token_hash_algorithm, token_hash_key_version, issued_at, expires_at
		 ) VALUES ($1, $2, 0, $3, 'HMAC-SHA256', $4, $5, $6)`,
		[
			draft.refreshCredentialId,
			draft.sessionId,
			draft.refreshTokenHash.value,
			draft.refreshTokenHash.keyVersion,
			draft.issuedAt,
			draft.refreshExpiresAt,
		],
	);
	await insertAccessToken(
		transaction,
		draft.sessionId,
		draft.accessCredentialId,
		draft.accessTokenHash,
		draft.issuedAt,
		draft.accessExpiresAt,
		draft.accessRetainUntil,
	);
}

async function insertAccessToken(
	transaction: DatabaseTransaction,
	sessionId: string,
	credentialId: string,
	tokenHash: VersionedHash,
	issuedAt: Date,
	expiresAt: Date,
	retainUntil: Date,
): Promise<void> {
	await transaction.query(
		`INSERT INTO public.auth_access_tokens (
		   id, session_family_id, token_hash, token_hash_algorithm,
		   token_hash_key_version, issued_at, expires_at, retain_until
		 ) VALUES ($1, $2, $3, 'HMAC-SHA256', $4, $5, $6, $7)`,
		[
			credentialId,
			sessionId,
			tokenHash.value,
			tokenHash.keyVersion,
			issuedAt,
			expiresAt,
			retainUntil,
		],
	);
}

function mapOtpProof(row: OtpProofRow | undefined): OtpProof | null {
	return row === undefined
		? null
		: Object.freeze({
				id: row.id,
				channel: row.channel,
				purpose: row.purpose,
				destinationDedupHash: row.destination_dedup_hash,
				verificationMethod: row.verification_method,
				codeHash: row.code_hash,
				codeHashKeyVersion: row.code_hash_key_version,
				operationTargetHash: row.operation_target_hash,
				targetUserId: row.target_user_id,
				registrationFlowReferenceHash: row.registration_flow_reference_hash,
				deviceHash: row.device_hash,
				hashKeyVersion: row.hash_key_version,
			});
}

function mapOAuthProof(row: OAuthProofRow | undefined): OAuthProof | null {
	return row === undefined
		? null
		: Object.freeze({
				id: row.id,
				provider: row.provider,
				purpose: row.purpose,
				flowReferenceHash: row.flow_reference_hash,
				operationTargetHash: row.operation_target_hash,
				targetUserId: row.target_user_id,
				deviceHash: row.device_hash,
				hashKeyVersion: row.hash_key_version,
			});
}

function hashArrays(
	hashes: readonly VersionedHash[],
): readonly [readonly string[], readonly string[]] {
	return [
		hashes.map((candidate) => candidate.value),
		hashes.map((candidate) => candidate.keyVersion),
	] as const;
}

function asDate(value: Date | string): Date {
	const parsed =
		value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (!Number.isFinite(parsed.getTime()))
		throw new Error("invalid database timestamp");
	return parsed;
}

function asSafeNonNegativeInteger(value: number | string): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error("invalid non-negative database integer");
	}
	return parsed;
}

function mapDataExportRecord(row: ExportStatusRow): DataExportRecord {
	const common = Object.freeze({
		exportId: row.export_id,
		requestedAt: asDate(row.requested_at),
		expiresAt: asDate(row.expires_at),
		includeBehaviorHistory: row.include_behavior_history,
	});
	if (row.export_status === "QUEUED" || row.export_status === "PROCESSING") {
		return Object.freeze({ ...common, status: row.export_status });
	}
	if (row.export_status === "READY") {
		if (
			row.ready_at === null ||
			row.artifact_size_bytes === null ||
			row.artifact_sha256 === null ||
			!/^[0-9a-f]{64}$/u.test(row.artifact_sha256)
		) {
			throw new Error("ready data export metadata is invalid");
		}
		return Object.freeze({
			...common,
			status: "READY" as const,
			readyAt: asDate(row.ready_at),
			artifactSizeBytes: asSafeNonNegativeInteger(row.artifact_size_bytes),
			artifactSha256: row.artifact_sha256,
		});
	}
	if (row.export_status === "FAILED") {
		// Database/worker failure details are deliberately collapsed to one public,
		// stable code so internal provider and storage information cannot leak.
		return Object.freeze({
			...common,
			status: "FAILED" as const,
			failureCode: "GENERATION_FAILED" as const,
		});
	}
	if (row.export_status === "EXPIRED") {
		return Object.freeze({ ...common, status: "EXPIRED" as const });
	}
	throw new Error("unsupported data export status");
}

function toCount(value: number | string): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0
		? parsed
		: Number.MAX_SAFE_INTEGER;
}

function maximumTriggeredRetryAfterMs(
	now: Date,
	resendDelayMs: number,
	count: CountRow,
): number | null {
	const triggeredWaits: number[] = [];
	addTriggeredWait(
		triggeredWaits,
		toCount(count.pending_count) >= 1,
		count.pending_oldest,
		now,
		resendDelayMs,
	);
	addTriggeredWait(
		triggeredWaits,
		toCount(count.destination_hour_count) >= 5,
		count.destination_hour_oldest,
		now,
		60 * 60_000,
	);
	// Alibaba Cloud's default domestic verification-code ceiling is ten per
	// recipient in 24 hours. Enforcing the same bound before the billed API call
	// protects both channels even if a provider-side setting is later relaxed.
	addTriggeredWait(
		triggeredWaits,
		toCount(count.destination_day_count) >= 10,
		count.destination_day_oldest,
		now,
		24 * 60 * 60_000,
	);
	addTriggeredWait(
		triggeredWaits,
		toCount(count.device_count) >= 10,
		count.device_oldest,
		now,
		60 * 60_000,
	);
	addTriggeredWait(
		triggeredWaits,
		toCount(count.ip_count) >= 30,
		count.ip_oldest,
		now,
		60 * 60_000,
	);
	return triggeredWaits.length === 0 ? null : Math.max(...triggeredWaits);
}

function addTriggeredWait(
	waits: number[],
	triggered: boolean,
	oldest: Date | string | null,
	now: Date,
	windowMs: number,
): void {
	if (!triggered) return;
	// A missing/invalid aggregate timestamp must fail closed. One second avoids
	// emitting Retry-After: 0 while leaving the durable limit in force.
	const oldestMs = oldest === null ? Number.NaN : new Date(oldest).getTime();
	const wait = Number.isFinite(oldestMs)
		? oldestMs + windowMs - now.getTime()
		: 1_000;
	waits.push(Math.max(1_000, wait));
}
