import { randomBytes, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
	type DataExportWorkerQueryClient,
	DataExportWorkerRepositoryError,
	PostgresDataExportWorkerRepository,
} from "./export-worker.repository.js";

const identity = Object.freeze({
	workerHash: "a".repeat(64),
	hashKeyVersion: "lease-v1",
});

class StubClient implements DataExportWorkerQueryClient {
	readonly calls: Array<{
		readonly text: string;
		readonly values: readonly unknown[];
	}> = [];
	rows: readonly QueryResultRow[] = [];
	error: unknown = null;

	async query<Row extends QueryResultRow>(
		text: string,
		values: readonly unknown[] = [],
	): Promise<{ readonly rows: readonly Row[] }> {
		this.calls.push({ text, values });
		if (this.error !== null) throw this.error;
		return { rows: this.rows as readonly Row[] };
	}
}

describe("PostgresDataExportWorkerRepository", () => {
	it("claims a staged retry through the SECURITY DEFINER primitive only", async () => {
		const client = new StubClient();
		const ciphertext = randomBytes(48);
		const exportId = randomUUID();
		const userId = randomUUID();
		client.rows = [
			{
				export_id: exportId,
				user_id: userId,
				include_behavior_history: true,
				state_version: "7",
				attempt_number: 2,
				lease_expires_at: "2026-08-21T12:05:00.000Z",
				artifact_locator_ciphertext: ciphertext,
				artifact_encryption_key_version: "locator-v1",
				artifact_sha256: "b".repeat(64),
				artifact_size_bytes: "1024",
				artifact_content_type: "application/json",
			},
		];
		const repository = new PostgresDataExportWorkerRepository(client);

		const claim = await repository.claimNextJob(identity, 120);

		expect(claim).toMatchObject({
			exportId,
			userId,
			includeBehaviorHistory: true,
			stateVersion: 7,
			attemptNumber: 2,
			stagedArtifact: {
				locatorKeyVersion: "locator-v1",
				sha256Hex: "b".repeat(64),
				sizeBytes: 1024,
				contentType: "application/json",
			},
		});
		expect(claim?.stagedArtifact?.locatorCiphertext).not.toBe(ciphertext);
		expect(claim?.stagedArtifact?.locatorCiphertext).toEqual(ciphertext);
		expect(client.calls[0]?.text).toContain(
			"public.export_claim_next_job($1, $2, $3)",
		);
		expect(client.calls[0]?.text).not.toMatch(
			/\b(?:from|join|update|insert|delete)\s+public\.data_export_jobs\b/iu,
		);
		expect(client.calls[0]?.values).toEqual([
			identity.workerHash,
			identity.hashKeyVersion,
			120,
		]);
		claim?.stagedArtifact?.locatorCiphertext.fill(0);
		ciphertext.fill(0);
	});

	it("rejects extra, partial, incoherent, or duplicate database rows", async () => {
		const client = new StubClient();
		const repository = new PostgresDataExportWorkerRepository(client);
		const base = {
			export_id: randomUUID(),
			user_id: randomUUID(),
			include_behavior_history: false,
			state_version: "1",
			attempt_number: 1,
			lease_expires_at: new Date("2026-08-21T12:05:00.000Z"),
			artifact_locator_ciphertext: null,
			artifact_encryption_key_version: null,
			artifact_sha256: null,
			artifact_size_bytes: null,
			artifact_content_type: null,
		};

		client.rows = [{ ...base, unexpected_secret: "must-not-pass" }];
		await expect(repository.claimNextJob(identity, 120)).rejects.toMatchObject({
			failure: "INVALID_DATABASE_RESULT",
		});

		client.rows = [
			{
				...base,
				artifact_locator_ciphertext: randomBytes(48),
			},
		];
		await expect(repository.claimNextJob(identity, 120)).rejects.toMatchObject({
			failure: "INVALID_DATABASE_RESULT",
		});

		client.rows = [base, base];
		await expect(repository.claimNextJob(identity, 120)).rejects.toMatchObject({
			failure: "INVALID_DATABASE_RESULT",
		});
	});

	it("uses fenced stage, renew, snapshot, complete and fail functions", async () => {
		const client = new StubClient();
		const repository = new PostgresDataExportWorkerRepository(client);
		const exportId = randomUUID();
		const locatorCiphertext = randomBytes(48);

		client.rows = [
			{
				new_state_version: "2",
				lease_expires_at: "2026-08-21T12:05:00.000Z",
			},
		];
		await expect(
			repository.stageArtifact({
				exportId,
				identity,
				expectedStateVersion: 1,
				locatorCiphertext,
				locatorKeyVersion: "locator-v1",
				artifactSha256Hex: "b".repeat(64),
				artifactSizeBytes: 1024,
				artifactContentType: "application/json",
			}),
		).resolves.toMatchObject({ stateVersion: 2 });
		expect(client.calls.at(-1)?.text).toContain(
			"public.export_stage_job_artifact($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		);

		client.rows = [
			{
				new_state_version: 3,
				lease_purpose: "BUILD",
				lease_expires_at: "2026-08-21T12:06:00.000Z",
			},
		];
		await expect(
			repository.renewLease(exportId, identity, 2, 120),
		).resolves.toMatchObject({ stateVersion: 3, purpose: "BUILD" });
		expect(client.calls.at(-1)?.text).toContain(
			"public.export_renew_job_lease($1, $2, $3, $4, $5)",
		);

		client.rows = [{ snapshot: { schemaVersion: 1 } }];
		await expect(
			repository.buildSafeSnapshot(exportId, identity),
		).resolves.toEqual({ schemaVersion: 1 });
		expect(client.calls.at(-1)?.text).toContain(
			"public.export_build_safe_snapshot($1, $2, $3)",
		);

		client.rows = [
			{
				new_state_version: "4",
				ready_at: "2026-08-21T12:01:00.000Z",
				expires_at: "2026-08-28T12:01:00.000Z",
			},
		];
		await expect(
			repository.completeJob({
				exportId,
				identity,
				expectedStateVersion: 3,
			}),
		).resolves.toMatchObject({ stateVersion: 4 });
		expect(client.calls.at(-1)?.text).toContain(
			"public.export_complete_job($1, $2, $3, $4)",
		);

		client.rows = [{ export_status: "QUEUED", new_state_version: "5" }];
		await expect(
			repository.failJob({
				exportId,
				identity,
				expectedStateVersion: 4,
				failureCode: "ARTIFACT_UPLOAD_FAILED",
				retryable: true,
			}),
		).resolves.toEqual({ status: "QUEUED", stateVersion: 5 });
		expect(client.calls.at(-1)?.text).toContain(
			"public.export_fail_job($1, $2, $3, $4, $5, $6)",
		);
		locatorCiphertext.fill(0);
	});

	it("parses both staged-only and completed deletion claims and zeroes bad copies", async () => {
		const client = new StubClient();
		const repository = new PostgresDataExportWorkerRepository(client);
		const ciphertext = randomBytes(48);
		client.rows = [
			{
				export_id: randomUUID(),
				state_version: "8",
				artifact_locator_ciphertext: ciphertext,
				artifact_encryption_key_version: "locator-v1",
				artifact_sha256: null,
				artifact_size_bytes: null,
				artifact_content_type: null,
				lease_expires_at: "2026-08-21T12:05:00.000Z",
			},
		];
		const staged = await repository.claimNextArtifactDeletion(identity, 120);
		expect(staged?.artifact).toBeNull();
		expect(staged?.locatorCiphertext).not.toBe(ciphertext);

		client.rows = [
			{
				...client.rows[0],
				artifact_sha256: "c".repeat(64),
				artifact_size_bytes: "2048",
				artifact_content_type: "application/json",
			},
		];
		const completed = await repository.claimNextArtifactDeletion(identity, 120);
		expect(completed?.artifact).toEqual({
			sha256Hex: "c".repeat(64),
			sizeBytes: 2048,
			contentType: "application/json",
		});

		client.rows = [
			{
				...client.rows[0],
				artifact_content_type: "text/plain",
			},
		];
		await expect(
			repository.claimNextArtifactDeletion(identity, 120),
		).rejects.toBeInstanceOf(DataExportWorkerRepositoryError);

		staged?.locatorCiphertext.fill(0);
		completed?.locatorCiphertext.fill(0);
		ciphertext.fill(0);
	});

	it("maps driver failures to a message-safe repository error", async () => {
		const client = new StubClient();
		client.error = new Error("secret connection string and SQL detail");
		const repository = new PostgresDataExportWorkerRepository(client);
		await expect(repository.claimNextJob(identity, 120)).rejects.toEqual(
			new DataExportWorkerRepositoryError("DATABASE_UNAVAILABLE"),
		);
	});

	it("maps PostgreSQL snapshot budgets to a fatal-safe public code", async () => {
		const client = new StubClient();
		client.error = { code: "54000", detail: "sensitive database detail" };
		const repository = new PostgresDataExportWorkerRepository(client);
		await expect(
			repository.buildSafeSnapshot(randomUUID(), identity),
		).rejects.toEqual(
			new DataExportWorkerRepositoryError("SNAPSHOT_TOO_LARGE"),
		);
	});
});
