import type { QueryResultRow } from "pg";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface ExportWorkerLeaseIdentity {
	readonly workerHash: string;
	readonly hashKeyVersion: string;
}

export interface ClaimedExportJob {
	readonly exportId: string;
	readonly userId: string;
	readonly includeBehaviorHistory: boolean;
	readonly stateVersion: number;
	readonly attemptNumber: number;
	readonly leaseExpiresAt: Date;
	readonly stagedArtifact: {
		readonly locatorCiphertext: Buffer;
		readonly locatorKeyVersion: string;
		readonly sha256Hex: string;
		readonly sizeBytes: number;
		readonly contentType: "application/json";
	} | null;
}

export interface RenewedExportLease {
	readonly stateVersion: number;
	readonly purpose: "BUILD" | "DELETE";
	readonly leaseExpiresAt: Date;
}

export interface StagedExportArtifact {
	readonly stateVersion: number;
	readonly leaseExpiresAt: Date;
}

export interface CompletedExportJob {
	readonly stateVersion: number;
	readonly readyAt: Date;
	readonly expiresAt: Date;
}

export type ExportWorkerFailureCode =
	| "SOURCE_READ_FAILED"
	| "SNAPSHOT_TOO_LARGE"
	| "ARTIFACT_UPLOAD_FAILED"
	| "ARTIFACT_VERIFY_FAILED"
	| "LEASE_EXPIRED"
	| "RETRY_EXHAUSTED"
	| "INTERNAL_ERROR";

export interface FailedExportJob {
	readonly status: "QUEUED" | "FAILED" | "EXPIRED";
	readonly stateVersion: number;
}

export interface ClaimedArtifactDeletion {
	readonly exportId: string;
	readonly stateVersion: number;
	readonly locatorCiphertext: Buffer;
	readonly locatorKeyVersion: string;
	readonly artifact: {
		readonly sha256Hex: string;
		readonly sizeBytes: number;
		readonly contentType: "application/json";
	} | null;
	readonly leaseExpiresAt: Date;
}

export interface DeletedExportArtifact {
	readonly stateVersion: number;
	readonly deletedAt: Date;
}

export interface StageExportArtifactInput {
	readonly exportId: string;
	readonly identity: ExportWorkerLeaseIdentity;
	readonly expectedStateVersion: number;
	readonly locatorCiphertext: Buffer;
	readonly locatorKeyVersion: string;
	readonly artifactSha256Hex: string;
	readonly artifactSizeBytes: number;
	readonly artifactContentType: "application/json";
}

export interface CompleteExportJobInput {
	readonly exportId: string;
	readonly identity: ExportWorkerLeaseIdentity;
	readonly expectedStateVersion: number;
}

export interface FailExportJobInput {
	readonly exportId: string;
	readonly identity: ExportWorkerLeaseIdentity;
	readonly expectedStateVersion: number;
	readonly failureCode: ExportWorkerFailureCode;
	readonly retryable: boolean;
}

/**
 * Worker-only persistence boundary. Implementations may call only the
 * SECURITY DEFINER functions from migration 0006; no table reads are exposed
 * to the application service.
 */
export interface DataExportWorkerRepository {
	claimNextJob(
		identity: ExportWorkerLeaseIdentity,
		leaseSeconds: number,
	): Promise<ClaimedExportJob | null>;
	renewLease(
		exportId: string,
		identity: ExportWorkerLeaseIdentity,
		expectedStateVersion: number,
		leaseSeconds: number,
	): Promise<RenewedExportLease | null>;
	stageArtifact(
		input: StageExportArtifactInput,
	): Promise<StagedExportArtifact | null>;
	buildSafeSnapshot(
		exportId: string,
		identity: ExportWorkerLeaseIdentity,
	): Promise<unknown>;
	completeJob(
		input: CompleteExportJobInput,
	): Promise<CompletedExportJob | null>;
	failJob(input: FailExportJobInput): Promise<FailedExportJob | null>;
	claimNextArtifactDeletion(
		identity: ExportWorkerLeaseIdentity,
		leaseSeconds: number,
	): Promise<ClaimedArtifactDeletion | null>;
	markArtifactDeleted(
		exportId: string,
		identity: ExportWorkerLeaseIdentity,
		expectedStateVersion: number,
	): Promise<DeletedExportArtifact | null>;
}

export type DataExportWorkerRepositoryFailure =
	| "DATABASE_UNAVAILABLE"
	| "SNAPSHOT_TOO_LARGE"
	| "INVALID_DATABASE_RESULT";

export class DataExportWorkerRepositoryError extends Error {
	constructor(readonly failure: DataExportWorkerRepositoryFailure) {
		super("数据导出工作器数据库操作失败");
		this.name = "DataExportWorkerRepositoryError";
	}
}

export interface DataExportWorkerQueryClient {
	query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[],
	): Promise<{ readonly rows: readonly Row[] }>;
}

interface ClaimJobRow extends QueryResultRow {
	readonly export_id: unknown;
	readonly user_id: unknown;
	readonly include_behavior_history: unknown;
	readonly state_version: unknown;
	readonly attempt_number: unknown;
	readonly lease_expires_at: unknown;
	readonly artifact_locator_ciphertext: unknown;
	readonly artifact_encryption_key_version: unknown;
	readonly artifact_sha256: unknown;
	readonly artifact_size_bytes: unknown;
	readonly artifact_content_type: unknown;
}

interface RenewLeaseRow extends QueryResultRow {
	readonly new_state_version: unknown;
	readonly lease_purpose: unknown;
	readonly lease_expires_at: unknown;
}

interface StageArtifactRow extends QueryResultRow {
	readonly new_state_version: unknown;
	readonly lease_expires_at: unknown;
}

interface SnapshotRow extends QueryResultRow {
	readonly snapshot: unknown;
}

interface CompleteJobRow extends QueryResultRow {
	readonly new_state_version: unknown;
	readonly ready_at: unknown;
	readonly expires_at: unknown;
}

interface FailJobRow extends QueryResultRow {
	readonly export_status: unknown;
	readonly new_state_version: unknown;
}

interface ClaimDeletionRow extends QueryResultRow {
	readonly export_id: unknown;
	readonly state_version: unknown;
	readonly artifact_locator_ciphertext: unknown;
	readonly artifact_encryption_key_version: unknown;
	readonly artifact_sha256: unknown;
	readonly artifact_size_bytes: unknown;
	readonly artifact_content_type: unknown;
	readonly lease_expires_at: unknown;
}

interface MarkDeletedRow extends QueryResultRow {
	readonly new_state_version: unknown;
	readonly artifact_deleted_at: unknown;
}

export class PostgresDataExportWorkerRepository
	implements DataExportWorkerRepository
{
	constructor(private readonly client: DataExportWorkerQueryClient) {}

	async claimNextJob(
		identity: ExportWorkerLeaseIdentity,
		leaseSeconds: number,
	): Promise<ClaimedExportJob | null> {
		assertIdentity(identity);
		assertLeaseSeconds(leaseSeconds);
		const row = await this.oneOrNone<ClaimJobRow>(
			`SELECT export_id, user_id, include_behavior_history, state_version,
			        attempt_number, lease_expires_at, artifact_locator_ciphertext,
			        artifact_encryption_key_version, artifact_sha256,
			        artifact_size_bytes, artifact_content_type
			 FROM public.export_claim_next_job($1, $2, $3)`,
			[identity.workerHash, identity.hashKeyVersion, leaseSeconds],
			[
				"export_id",
				"user_id",
				"include_behavior_history",
				"state_version",
				"attempt_number",
				"lease_expires_at",
				"artifact_locator_ciphertext",
				"artifact_encryption_key_version",
				"artifact_sha256",
				"artifact_size_bytes",
				"artifact_content_type",
			],
		);
		if (row === null) return null;
		const ciphertext = nullableCiphertext(
			row.artifact_locator_ciphertext,
			"artifact locator ciphertext",
		);
		const locatorKeyVersion = nullableKeyVersion(
			row.artifact_encryption_key_version,
		);
		try {
			const metadataAllNull =
				row.artifact_sha256 === null &&
				row.artifact_size_bytes === null &&
				row.artifact_content_type === null;
			if (
				(ciphertext === null) !== (locatorKeyVersion === null) ||
				(ciphertext === null) !== metadataAllNull
			) {
				throw invalidResult();
			}
			const expected =
				ciphertext === null
					? null
					: Object.freeze({
							sha256Hex: sha256(row.artifact_sha256),
							sizeBytes: artifactSize(row.artifact_size_bytes),
							contentType: contentType(row.artifact_content_type),
						});
			return Object.freeze({
				exportId: uuid(row.export_id),
				userId: uuid(row.user_id),
				includeBehaviorHistory: boolean(row.include_behavior_history),
				stateVersion: positiveInteger(row.state_version),
				attemptNumber: boundedInteger(row.attempt_number, 1, 5),
				leaseExpiresAt: timestamp(row.lease_expires_at),
				stagedArtifact:
					ciphertext === null
						? null
						: Object.freeze({
								locatorCiphertext: ciphertext,
								locatorKeyVersion: locatorKeyVersion as string,
								sha256Hex: expected?.sha256Hex as string,
								sizeBytes: expected?.sizeBytes as number,
								contentType: expected?.contentType as "application/json",
							}),
			});
		} catch (error) {
			ciphertext?.fill(0);
			throw error;
		}
	}

	async renewLease(
		exportId: string,
		identity: ExportWorkerLeaseIdentity,
		expectedStateVersion: number,
		leaseSeconds: number,
	): Promise<RenewedExportLease | null> {
		assertUuid(exportId);
		assertIdentity(identity);
		assertPositiveInteger(expectedStateVersion);
		assertLeaseSeconds(leaseSeconds);
		const row = await this.oneOrNone<RenewLeaseRow>(
			`SELECT new_state_version, lease_purpose, lease_expires_at
			 FROM public.export_renew_job_lease($1, $2, $3, $4, $5)`,
			[
				exportId,
				identity.workerHash,
				identity.hashKeyVersion,
				expectedStateVersion,
				leaseSeconds,
			],
			["new_state_version", "lease_purpose", "lease_expires_at"],
		);
		if (row === null) return null;
		if (row.lease_purpose !== "BUILD" && row.lease_purpose !== "DELETE") {
			throw invalidResult();
		}
		return Object.freeze({
			stateVersion: positiveInteger(row.new_state_version),
			purpose: row.lease_purpose,
			leaseExpiresAt: timestamp(row.lease_expires_at),
		});
	}

	async stageArtifact(
		input: StageExportArtifactInput,
	): Promise<StagedExportArtifact | null> {
		assertUuid(input.exportId);
		assertIdentity(input.identity);
		assertPositiveInteger(input.expectedStateVersion);
		assertCiphertext(input.locatorCiphertext, "artifact locator ciphertext");
		assertKeyVersion(input.locatorKeyVersion);
		if (!SHA256_PATTERN.test(input.artifactSha256Hex)) throw new Error("hash");
		if (
			!Number.isSafeInteger(input.artifactSizeBytes) ||
			input.artifactSizeBytes < 1 ||
			input.artifactSizeBytes > MAXIMUM_ARTIFACT_BYTES ||
			input.artifactContentType !== "application/json"
		) {
			throw new Error("artifact metadata");
		}
		const row = await this.oneOrNone<StageArtifactRow>(
			`SELECT new_state_version, lease_expires_at
			 FROM public.export_stage_job_artifact($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[
				input.exportId,
				input.identity.workerHash,
				input.identity.hashKeyVersion,
				input.expectedStateVersion,
				input.locatorCiphertext,
				input.locatorKeyVersion,
				input.artifactSha256Hex,
				input.artifactSizeBytes,
				input.artifactContentType,
			],
			["new_state_version", "lease_expires_at"],
		);
		return row === null
			? null
			: Object.freeze({
					stateVersion: positiveInteger(row.new_state_version),
					leaseExpiresAt: timestamp(row.lease_expires_at),
				});
	}

	async buildSafeSnapshot(
		exportId: string,
		identity: ExportWorkerLeaseIdentity,
	): Promise<unknown> {
		assertUuid(exportId);
		assertIdentity(identity);
		const row = await this.exactlyOne<SnapshotRow>(
			"SELECT public.export_build_safe_snapshot($1, $2, $3) AS snapshot",
			[exportId, identity.workerHash, identity.hashKeyVersion],
			["snapshot"],
		);
		if (
			typeof row.snapshot !== "object" ||
			row.snapshot === null ||
			Array.isArray(row.snapshot)
		) {
			throw invalidResult();
		}
		return row.snapshot;
	}

	async completeJob(
		input: CompleteExportJobInput,
	): Promise<CompletedExportJob | null> {
		assertUuid(input.exportId);
		assertIdentity(input.identity);
		assertPositiveInteger(input.expectedStateVersion);
		const row = await this.oneOrNone<CompleteJobRow>(
			`SELECT new_state_version, ready_at, expires_at
			 FROM public.export_complete_job($1, $2, $3, $4)`,
			[
				input.exportId,
				input.identity.workerHash,
				input.identity.hashKeyVersion,
				input.expectedStateVersion,
			],
			["new_state_version", "ready_at", "expires_at"],
		);
		if (row === null) return null;
		const readyAt = timestamp(row.ready_at);
		const expiresAt = timestamp(row.expires_at);
		if (expiresAt.getTime() <= readyAt.getTime()) throw invalidResult();
		return Object.freeze({
			stateVersion: positiveInteger(row.new_state_version),
			readyAt,
			expiresAt,
		});
	}

	async failJob(input: FailExportJobInput): Promise<FailedExportJob | null> {
		assertUuid(input.exportId);
		assertIdentity(input.identity);
		assertPositiveInteger(input.expectedStateVersion);
		assertFailureCode(input.failureCode);
		const row = await this.oneOrNone<FailJobRow>(
			`SELECT export_status, new_state_version
			 FROM public.export_fail_job($1, $2, $3, $4, $5, $6)`,
			[
				input.exportId,
				input.identity.workerHash,
				input.identity.hashKeyVersion,
				input.expectedStateVersion,
				input.failureCode,
				input.retryable,
			],
			["export_status", "new_state_version"],
		);
		if (row === null) return null;
		if (
			row.export_status !== "QUEUED" &&
			row.export_status !== "FAILED" &&
			row.export_status !== "EXPIRED"
		) {
			throw invalidResult();
		}
		return Object.freeze({
			status: row.export_status,
			stateVersion: positiveInteger(row.new_state_version),
		});
	}

	async claimNextArtifactDeletion(
		identity: ExportWorkerLeaseIdentity,
		leaseSeconds: number,
	): Promise<ClaimedArtifactDeletion | null> {
		assertIdentity(identity);
		assertLeaseSeconds(leaseSeconds);
		const row = await this.oneOrNone<ClaimDeletionRow>(
			`SELECT export_id, state_version, artifact_locator_ciphertext,
			        artifact_encryption_key_version, artifact_sha256,
			        artifact_size_bytes, artifact_content_type, lease_expires_at
			 FROM public.export_claim_next_artifact_deletion($1, $2, $3)`,
			[identity.workerHash, identity.hashKeyVersion, leaseSeconds],
			[
				"export_id",
				"state_version",
				"artifact_locator_ciphertext",
				"artifact_encryption_key_version",
				"artifact_sha256",
				"artifact_size_bytes",
				"artifact_content_type",
				"lease_expires_at",
			],
		);
		if (row === null) return null;
		const locatorCiphertext = ciphertext(
			row.artifact_locator_ciphertext,
			"artifact locator ciphertext",
		);
		try {
			const metadataAllNull =
				row.artifact_sha256 === null &&
				row.artifact_size_bytes === null &&
				row.artifact_content_type === null;
			const metadataAllPresent =
				typeof row.artifact_sha256 === "string" &&
				row.artifact_size_bytes !== null &&
				row.artifact_content_type === "application/json";
			if (!metadataAllNull && !metadataAllPresent) throw invalidResult();
			const artifact = metadataAllNull
				? null
				: Object.freeze({
						sha256Hex: sha256(row.artifact_sha256),
						sizeBytes: artifactSize(row.artifact_size_bytes),
						contentType: "application/json" as const,
					});
			return Object.freeze({
				exportId: uuid(row.export_id),
				stateVersion: positiveInteger(row.state_version),
				locatorCiphertext,
				locatorKeyVersion: keyVersion(row.artifact_encryption_key_version),
				artifact,
				leaseExpiresAt: timestamp(row.lease_expires_at),
			});
		} catch (error) {
			locatorCiphertext.fill(0);
			throw error;
		}
	}

	async markArtifactDeleted(
		exportId: string,
		identity: ExportWorkerLeaseIdentity,
		expectedStateVersion: number,
	): Promise<DeletedExportArtifact | null> {
		assertUuid(exportId);
		assertIdentity(identity);
		assertPositiveInteger(expectedStateVersion);
		const row = await this.oneOrNone<MarkDeletedRow>(
			`SELECT new_state_version, artifact_deleted_at
			 FROM public.export_mark_artifact_deleted($1, $2, $3, $4)`,
			[
				exportId,
				identity.workerHash,
				identity.hashKeyVersion,
				expectedStateVersion,
			],
			["new_state_version", "artifact_deleted_at"],
		);
		return row === null
			? null
			: Object.freeze({
					stateVersion: positiveInteger(row.new_state_version),
					deletedAt: timestamp(row.artifact_deleted_at),
				});
	}

	private async oneOrNone<Row extends QueryResultRow>(
		text: string,
		values: readonly unknown[],
		expectedKeys: readonly string[],
	): Promise<Row | null> {
		const rows = await this.query<Row>(text, values);
		if (rows.length > 1) throw invalidResult();
		const row = rows[0];
		if (row === undefined) return null;
		assertExactKeys(row, expectedKeys);
		return row;
	}

	private async exactlyOne<Row extends QueryResultRow>(
		text: string,
		values: readonly unknown[],
		expectedKeys: readonly string[],
	): Promise<Row> {
		const row = await this.oneOrNone<Row>(text, values, expectedKeys);
		if (row === null) throw invalidResult();
		return row;
	}

	private async query<Row extends QueryResultRow>(
		text: string,
		values: readonly unknown[],
	): Promise<readonly Row[]> {
		try {
			const result = await this.client.query<Row>(text, values);
			if (!Array.isArray(result.rows)) throw invalidResult();
			return result.rows;
		} catch (error) {
			if (error instanceof DataExportWorkerRepositoryError) throw error;
			if (isSnapshotBudgetError(error)) {
				throw new DataExportWorkerRepositoryError("SNAPSHOT_TOO_LARGE");
			}
			throw new DataExportWorkerRepositoryError("DATABASE_UNAVAILABLE");
		}
	}
}

function assertExactKeys(
	value: QueryResultRow,
	expectedKeys: readonly string[],
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidResult();
	}
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw invalidResult();
	}
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw invalidResult();
	}
	return value.toLowerCase();
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw invalidResult();
	return value;
}

function timestamp(value: unknown): Date {
	if (!(value instanceof Date) && typeof value !== "string") {
		throw invalidResult();
	}
	const parsed =
		value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw invalidResult();
	return parsed;
}

function boundedInteger(
	value: unknown,
	minimum: number,
	maximum: number,
): number {
	const parsed =
		typeof value === "bigint"
			? Number(value)
			: typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/u.test(value)
				? Number(value)
				: value;
	if (
		typeof parsed !== "number" ||
		!Number.isSafeInteger(parsed) ||
		parsed < minimum ||
		parsed > maximum
	) {
		throw invalidResult();
	}
	return parsed;
}

function positiveInteger(value: unknown): number {
	return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function artifactSize(value: unknown): number {
	return boundedInteger(value, 1, MAXIMUM_ARTIFACT_BYTES);
}

function ciphertext(value: unknown, _label: string): Buffer {
	if (
		!Buffer.isBuffer(value) ||
		value.byteLength < 16 ||
		value.byteLength > 4_096
	) {
		throw invalidResult();
	}
	return Buffer.from(value);
}

function nullableCiphertext(value: unknown, label: string): Buffer | null {
	return value === null ? null : ciphertext(value, label);
}

function keyVersion(value: unknown): string {
	if (typeof value !== "string" || !KEY_VERSION_PATTERN.test(value)) {
		throw invalidResult();
	}
	return value;
}

function nullableKeyVersion(value: unknown): string | null {
	return value === null ? null : keyVersion(value);
}

function sha256(value: unknown): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw invalidResult();
	}
	return value;
}

function contentType(value: unknown): "application/json" {
	if (value !== "application/json") throw invalidResult();
	return value;
}

function isSnapshotBudgetError(
	error: unknown,
): error is { readonly code: "54000" } {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "54000"
	);
}

function assertUuid(value: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error("export id");
}

function assertKeyVersion(value: string): void {
	if (!KEY_VERSION_PATTERN.test(value)) throw new Error("key version");
}

function assertIdentity(identity: ExportWorkerLeaseIdentity): void {
	if (
		!SHA256_PATTERN.test(identity.workerHash) ||
		!KEY_VERSION_PATTERN.test(identity.hashKeyVersion)
	) {
		throw new Error("worker identity");
	}
}

function assertPositiveInteger(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error("state version");
}

function assertLeaseSeconds(value: number): void {
	if (!Number.isInteger(value) || value < 30 || value > 900) {
		throw new Error("lease seconds");
	}
}

function assertCiphertext(value: Buffer, _label: string): void {
	if (
		!Buffer.isBuffer(value) ||
		value.byteLength < 16 ||
		value.byteLength > 4_096
	) {
		throw new Error("ciphertext");
	}
}

function assertFailureCode(value: ExportWorkerFailureCode): void {
	if (
		!(
			[
				"SOURCE_READ_FAILED",
				"SNAPSHOT_TOO_LARGE",
				"ARTIFACT_UPLOAD_FAILED",
				"ARTIFACT_VERIFY_FAILED",
				"LEASE_EXPIRED",
				"RETRY_EXHAUSTED",
				"INTERNAL_ERROR",
			] as const
		).includes(value)
	) {
		throw new Error("failure code");
	}
}

function invalidResult(): DataExportWorkerRepositoryError {
	return new DataExportWorkerRepositoryError("INVALID_DATABASE_RESULT");
}
