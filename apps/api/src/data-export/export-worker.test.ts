import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SupportFeedbackKeyRing } from "../support-feedback/support-feedback-crypto.js";
import {
	EXPORT_ARTIFACT_CONTENT_TYPE,
	type ExpectedExportArtifact,
	ExportArtifactStore,
	ExportArtifactStoreError,
	type OpenedExportArtifact,
	type PutExportArtifactInput,
	type StoredExportArtifact,
} from "./export-artifact.store.js";
import {
	decryptExportArtifactLocator,
	ExportLocatorKeyRing,
	encryptExportArtifactLocator,
} from "./export-artifact-crypto.js";
import {
	classifyExportWorkerFailure,
	createExportWorkerLeaseIdentity,
	DataExportWorker,
} from "./export-worker.js";
import { serializeExportSnapshot } from "./export-snapshot.js";
import {
	type ClaimedArtifactDeletion,
	type ClaimedExportJob,
	type CompletedExportJob,
	type CompleteExportJobInput,
	type DataExportWorkerRepository,
	type DeletedExportArtifact,
	type ExportWorkerLeaseIdentity,
	type FailExportJobInput,
	type FailedExportJob,
	type RenewedExportLease,
	type StagedExportArtifact,
	type StageExportArtifactInput,
} from "./export-worker.repository.js";

const FIXED_NOW = new Date("2026-08-21T12:00:00.000Z");

class FakeRepository implements DataExportWorkerRepository {
	readonly actions: string[] = [];
	job: ClaimedExportJob | null = null;
	deletion: ClaimedArtifactDeletion | null = null;
	snapshot: unknown = validSnapshot();
	completeResult: CompletedExportJob | null = Object.freeze({
		stateVersion: 9,
		readyAt: new Date("2026-08-21T12:00:05.000Z"),
		expiresAt: new Date("2026-08-28T12:00:05.000Z"),
	});
	failResult: FailedExportJob | null = Object.freeze({
		status: "FAILED",
		stateVersion: 9,
	});
	markResult: DeletedExportArtifact | null = Object.freeze({
		stateVersion: 9,
		deletedAt: new Date("2026-08-21T12:00:05.000Z"),
	});
	stageError: unknown = null;
	completeError: unknown = null;
	stageCiphertext: Buffer | null = null;
	stageKeyVersion: string | null = null;
	stageSha256Hex: string | null = null;
	stageSizeBytes: number | null = null;
	stageContentType: string | null = null;
	failureInput: FailExportJobInput | null = null;
	private stateVersion = 1;
	private leasePurpose: "BUILD" | "DELETE" = "BUILD";

	async claimNextJob(): Promise<ClaimedExportJob | null> {
		this.actions.push("claim-build");
		this.leasePurpose = "BUILD";
		this.stateVersion = this.job?.stateVersion ?? 1;
		return this.job;
	}

	async renewLease(
		_exportId: string,
		_identity: ExportWorkerLeaseIdentity,
		expectedStateVersion: number,
	): Promise<RenewedExportLease | null> {
		this.actions.push(`renew-${this.leasePurpose.toLowerCase()}`);
		this.stateVersion = Math.max(this.stateVersion, expectedStateVersion) + 1;
		return Object.freeze({
			stateVersion: this.stateVersion,
			purpose: this.leasePurpose,
			leaseExpiresAt: new Date("2026-08-21T12:05:00.000Z"),
		});
	}

	async stageArtifact(
		input: StageExportArtifactInput,
	): Promise<StagedExportArtifact | null> {
		this.actions.push("stage");
		if (this.stageError !== null) throw this.stageError;
		this.stageCiphertext = Buffer.from(input.locatorCiphertext);
		this.stageKeyVersion = input.locatorKeyVersion;
		this.stageSha256Hex = input.artifactSha256Hex;
		this.stageSizeBytes = input.artifactSizeBytes;
		this.stageContentType = input.artifactContentType;
		this.stateVersion =
			Math.max(this.stateVersion, input.expectedStateVersion) + 1;
		return Object.freeze({
			stateVersion: this.stateVersion,
			leaseExpiresAt: new Date("2026-08-21T12:05:00.000Z"),
		});
	}

	async buildSafeSnapshot(): Promise<unknown> {
		this.actions.push("snapshot");
		return this.snapshot;
	}

	async completeJob(
		_input: CompleteExportJobInput,
	): Promise<CompletedExportJob | null> {
		this.actions.push("complete");
		if (this.completeError !== null) throw this.completeError;
		return this.completeResult;
	}

	async failJob(input: FailExportJobInput): Promise<FailedExportJob | null> {
		this.actions.push("fail");
		this.failureInput = input;
		return this.failResult;
	}

	async claimNextArtifactDeletion(): Promise<ClaimedArtifactDeletion | null> {
		this.actions.push("claim-delete");
		this.leasePurpose = "DELETE";
		this.stateVersion = this.deletion?.stateVersion ?? 1;
		return this.deletion;
	}

	async markArtifactDeleted(): Promise<DeletedExportArtifact | null> {
		this.actions.push("mark-deleted");
		return this.markResult;
	}
}

class FakeArtifactStore extends ExportArtifactStore {
	readonly actions: string[] = [];
	putInput: PutExportArtifactInput | null = null;
	putBodyReference: Buffer | null = null;
	putBodyCopy: Buffer | null = null;
	putError: unknown = null;
	deleteLocator: string | null = null;
	deleteError: unknown = null;
	storedOverride: StoredExportArtifact | null = null;
	openBody: Buffer | null = null;
	openError: unknown = null;

	async putArtifact(
		input: PutExportArtifactInput,
	): Promise<StoredExportArtifact> {
		this.actions.push("put");
		this.putInput = input;
		this.putBodyReference = input.body;
		this.putBodyCopy = Buffer.from(input.body);
		if (this.putError !== null) throw this.putError;
		return (
			this.storedOverride ??
			Object.freeze({
				locator: input.locator,
				fileName: input.fileName,
				contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
				sizeBytes: input.body.byteLength,
				sha256Hex: createHash("sha256").update(input.body).digest("hex"),
			})
		);
	}

	async openArtifact(
		_locator: string,
		_expected: ExpectedExportArtifact,
	): Promise<OpenedExportArtifact> {
		this.actions.push("open");
		if (this.openError !== null) throw this.openError;
		const body = Buffer.from(this.openBody ?? Buffer.alloc(0));
		return Object.freeze({
			stream: Readable.from([body]),
			contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
			sizeBytes: body.byteLength,
		});
	}

	async deleteArtifact(locator: string): Promise<void> {
		this.actions.push("delete");
		this.deleteLocator = locator;
		if (this.deleteError !== null) throw this.deleteError;
	}
}

class ControllableTombstoneRaceStore extends FakeArtifactStore {
	objectState: "ABSENT" | "PERSONAL" | "TOMBSTONE" = "ABSENT";
	readonly putStarted: Promise<void>;
	#signalPutStarted: (() => void) | null = null;
	#resumePut: (() => void) | null = null;

	constructor() {
		super();
		this.putStarted = new Promise<void>((resolve) => {
			this.#signalPutStarted = resolve;
		});
	}

	resumePausedPut(): void {
		this.#resumePut?.();
	}

	override async putArtifact(
		input: PutExportArtifactInput,
	): Promise<StoredExportArtifact> {
		this.actions.push("put");
		this.putInput = input;
		this.putBodyReference = input.body;
		this.putBodyCopy = Buffer.from(input.body);
		this.#signalPutStarted?.();
		await new Promise<void>((resolve) => {
			this.#resumePut = resolve;
		});
		if (this.objectState === "TOMBSTONE") {
			throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
		}
		this.objectState = "PERSONAL";
		return Object.freeze({
			locator: input.locator,
			fileName: input.fileName,
			contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
			sizeBytes: input.body.byteLength,
			sha256Hex: createHash("sha256").update(input.body).digest("hex"),
		});
	}

	override async deleteArtifact(locator: string): Promise<void> {
		this.actions.push("delete");
		this.deleteLocator = locator;
		// Models the OSS contract: resolution means the fixed no-PII tombstone
		// was written and verified, not merely that DELETE returned 204.
		this.objectState = "TOMBSTONE";
	}
}

interface Rings {
	readonly locator: ExportLocatorKeyRing;
	readonly support: SupportFeedbackKeyRing;
	readonly locatorKey: Buffer;
	readonly supportKey: Buffer;
}

function rings(): Rings {
	const locatorKey = randomBytes(32);
	const supportKey = randomBytes(32);
	return {
		locator: new ExportLocatorKeyRing(
			"locator-v1",
			new Map([["locator-v1", locatorKey]]),
		),
		support: new SupportFeedbackKeyRing(
			"support-v1",
			new Map([["support-v1", supportKey]]),
		),
		locatorKey,
		supportKey,
	};
}

function destroyRings(value: Rings): void {
	value.locator.destroy();
	value.support.destroy();
	value.locatorKey.fill(0);
	value.supportKey.fill(0);
}

function identity(): ExportWorkerLeaseIdentity {
	const key = randomBytes(32);
	try {
		return createExportWorkerLeaseIdentity("lease-v1", key);
	} finally {
		key.fill(0);
	}
}

function buildJob(
	exportId = randomUUID(),
	stagedArtifact: ClaimedExportJob["stagedArtifact"] = null,
): ClaimedExportJob {
	return Object.freeze({
		exportId,
		userId: randomUUID(),
		includeBehaviorHistory: true,
		stateVersion: 1,
		attemptNumber: stagedArtifact === null ? 1 : 2,
		leaseExpiresAt: new Date("2026-08-21T12:05:00.000Z"),
		stagedArtifact,
	});
}

function validSnapshot(): object {
	return {
		schemaVersion: 1,
		generatedAt: "2026-08-21T12:00:01.000Z",
		account: {
			accountId: randomUUID(),
			status: "ACTIVE",
			createdAt: "2026-08-20T12:00:00.000Z",
		},
		identities: [],
		favorites: [],
		recommendationHistory: [],
		privateFeedback: [],
		preferences: {},
		supportFeedbackEncrypted: [],
	};
}

function worker(
	repository: FakeRepository,
	store: FakeArtifactStore,
	keyRings: Rings,
	maximumArtifactBytes = 10 * 1024 * 1024,
): DataExportWorker {
	return new DataExportWorker(
		repository,
		store,
		keyRings.locator,
		keyRings.support,
		identity(),
		{
			leaseSeconds: 120,
			maximumArtifactBytes,
			now: () => FIXED_NOW,
		},
	);
}

describe("DataExportWorker", () => {
	it("HMACs fresh process entropy and erases the owned random nonce", () => {
		const hmacKey = Buffer.alloc(32, 0x31);
		const entropy = Buffer.alloc(32, 0x42);
		const first = createExportWorkerLeaseIdentity(
			"lease-v1",
			hmacKey,
			() => entropy,
		);
		expect(first.workerHash).toMatch(/^[0-9a-f]{64}$/u);
		expect(first.workerHash).not.toContain("42".repeat(16));
		expect(entropy.every((value) => value === 0)).toBe(true);
		expect(hmacKey.every((value) => value === 0x31)).toBe(true);

		const otherEntropy = Buffer.alloc(32, 0x43);
		const second = createExportWorkerLeaseIdentity(
			"lease-v1",
			hmacKey,
			() => otherEntropy,
		);
		expect(second.workerHash).not.toBe(first.workerHash);
		hmacKey.fill(0);
	});

	it("freezes an encrypted locator and exact artifact expectation before upload", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		repository.job = buildJob(exportId);

		const result = await worker(repository, store, keyRings).runOnce();

		expect(result).toEqual({ kind: "EXPORT_READY", exportId });
		expect(repository.actions).toEqual([
			"claim-delete",
			"claim-build",
			"renew-build",
			"snapshot",
			"renew-build",
			"stage",
			"renew-build",
			"renew-build",
			"complete",
		]);
		expect(store.actions).toEqual(["put"]);
		expect(repository.actions.indexOf("snapshot")).toBeLessThan(
			repository.actions.indexOf("stage"),
		);
		expect(repository.stageCiphertext).not.toBeNull();
		const locator = decryptExportArtifactLocator(
			repository.stageCiphertext as Buffer,
			repository.stageKeyVersion as string,
			keyRings.locator,
		);
		expect(locator).toBe(`exports/v1/2026/08/${exportId}.json`);
		expect(store.putInput?.locator).toBe(locator);
		expect(store.putInput?.fileName).toBe(
			`chi-shen-me-data-export-${exportId}.json`,
		);
		expect(repository.stageSha256Hex).toBe(
			createHash("sha256").update(store.putBodyCopy as Buffer).digest("hex"),
		);
		expect(repository.stageSizeBytes).toBe(store.putBodyCopy?.byteLength);
		expect(repository.stageContentType).toBe("application/json");
		expect(store.putBodyCopy?.toString("utf8")).not.toMatch(
			/ciphertext|keyVersion|provider|token|coordinate|lease|hash/iu,
		);
		expect(store.putBodyReference?.every((value) => value === 0)).toBe(true);

		repository.stageCiphertext?.fill(0);
		store.putBodyCopy?.fill(0);
		destroyRings(keyRings);
	});

	it("completes a matching staged object without rebuilding or uploading", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		const locator = `exports/v1/2026/07/${exportId}.json`;
		const encrypted = encryptExportArtifactLocator(locator, keyRings.locator);
		const originalCiphertext = Buffer.from(encrypted.ciphertext);
		const serialized = serializeExportSnapshot(
			repository.snapshot,
			keyRings.support,
			10 * 1024 * 1024,
		).body;
		store.openBody = Buffer.from(serialized);
		repository.job = buildJob(
			exportId,
			Object.freeze({
				locatorCiphertext: encrypted.ciphertext,
				locatorKeyVersion: encrypted.keyVersion,
				sha256Hex: createHash("sha256").update(serialized).digest("hex"),
				sizeBytes: serialized.byteLength,
				contentType: "application/json",
			}),
		);

		await expect(
			worker(repository, store, keyRings).runOnce(),
		).resolves.toEqual({
			kind: "EXPORT_READY",
			exportId,
		});
		expect(repository.actions).not.toContain("snapshot");
		expect(repository.actions).not.toContain("stage");
		expect(store.actions).toEqual(["open"]);
		expect(store.putInput).toBeNull();
		expect(
			repository.job.stagedArtifact?.locatorCiphertext.every(
				(value) => value === 0,
			),
		).toBe(true);

		originalCiphertext.fill(0);
		serialized.fill(0);
		store.openBody?.fill(0);
		destroyRings(keyRings);
	});

	it("recovers PUT success with uncommitted completion on a new claimant", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		repository.job = buildJob(exportId);
		repository.completeResult = null;

		const first = await worker(repository, store, keyRings).runOnce();

		expect(first).toEqual({ kind: "LEASE_LOST", exportId, phase: "BUILD" });
		expect(repository.stageCiphertext).not.toBeNull();
		expect(store.actions).toEqual(["put"]);
		expect(repository.actions).not.toContain("fail");
		expect(store.actions).not.toContain("delete");
		expect(store.putBodyReference?.every((value) => value === 0)).toBe(true);

		const retryRepository = new FakeRepository();
		retryRepository.job = buildJob(
			exportId,
			Object.freeze({
				locatorCiphertext: Buffer.from(repository.stageCiphertext as Buffer),
				locatorKeyVersion: repository.stageKeyVersion as string,
				sha256Hex: repository.stageSha256Hex as string,
				sizeBytes: repository.stageSizeBytes as number,
				contentType: "application/json",
			}),
		);
		const retryStore = new FakeArtifactStore();
		retryStore.openBody = Buffer.from(store.putBodyCopy as Buffer);
		const second = await worker(
			retryRepository,
			retryStore,
			keyRings,
		).runOnce();
		expect(second).toEqual({ kind: "EXPORT_READY", exportId });
		expect(retryStore.actions).toEqual(["open"]);
		expect(retryStore.putInput).toBeNull();
		expect(retryRepository.actions).not.toContain("snapshot");
		expect(retryRepository.actions).not.toContain("stage");

		repository.stageCiphertext?.fill(0);
		store.putBodyCopy?.fill(0);
		retryStore.openBody?.fill(0);
		destroyRings(keyRings);
	});

	it("never overwrites a missing staged key with different regenerated bytes", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		const locator = `exports/v1/2026/08/${exportId}.json`;
		const encrypted = encryptExportArtifactLocator(locator, keyRings.locator);
		const frozenBody = Buffer.from("frozen prior artifact", "utf8");
		repository.job = buildJob(
			exportId,
			Object.freeze({
				locatorCiphertext: encrypted.ciphertext,
				locatorKeyVersion: encrypted.keyVersion,
				sha256Hex: createHash("sha256").update(frozenBody).digest("hex"),
				sizeBytes: frozenBody.byteLength,
				contentType: "application/json",
			}),
		);
		store.openError = new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");

		const result = await worker(repository, store, keyRings).runOnce();

		expect(result).toEqual({
			kind: "EXPORT_FAILED",
			exportId,
			failureCode: "ARTIFACT_VERIFY_FAILED",
		});
		expect(store.actions).toEqual(["open"]);
		expect(store.putInput).toBeNull();
		expect(repository.actions).toContain("snapshot");
		expect(repository.actions).not.toContain("stage");
		frozenBody.fill(0);
		destroyRings(keyRings);
	});

	it("recreates an absent staged object only when regenerated bytes match", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		const locator = `exports/v1/2026/08/${exportId}.json`;
		const encrypted = encryptExportArtifactLocator(locator, keyRings.locator);
		const serialized = serializeExportSnapshot(
			repository.snapshot,
			keyRings.support,
			10 * 1024 * 1024,
		).body;
		repository.job = buildJob(
			exportId,
			Object.freeze({
				locatorCiphertext: encrypted.ciphertext,
				locatorKeyVersion: encrypted.keyVersion,
				sha256Hex: createHash("sha256").update(serialized).digest("hex"),
				sizeBytes: serialized.byteLength,
				contentType: "application/json",
			}),
		);
		store.openError = new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");

		const result = await worker(repository, store, keyRings).runOnce();

		expect(result).toEqual({ kind: "EXPORT_READY", exportId });
		expect(store.actions).toEqual(["open", "put"]);
		expect(repository.actions).toContain("snapshot");
		expect(repository.actions).not.toContain("stage");
		expect(store.putBodyCopy).toEqual(serialized);
		serialized.fill(0);
		store.putBodyCopy?.fill(0);
		destroyRings(keyRings);
	});

	it("fences a paused stale PUT with a verified tombstone before DB deletion marker", async () => {
		const buildRepository = new FakeRepository();
		const store = new ControllableTombstoneRaceStore();
		const keyRings = rings();
		const exportId = randomUUID();
		buildRepository.job = buildJob(exportId);
		buildRepository.failResult = null;

		const staleBuild = worker(buildRepository, store, keyRings).runOnce();
		await store.putStarted;
		expect(buildRepository.stageCiphertext).not.toBeNull();
		expect(store.objectState).toBe("ABSENT");

		const deletionRepository = new FakeRepository();
		deletionRepository.deletion = Object.freeze({
			exportId,
			stateVersion: 20,
			locatorCiphertext: Buffer.from(
				buildRepository.stageCiphertext as Buffer,
			),
			locatorKeyVersion: buildRepository.stageKeyVersion as string,
			artifact: Object.freeze({
				sha256Hex: buildRepository.stageSha256Hex as string,
				sizeBytes: buildRepository.stageSizeBytes as number,
				contentType: "application/json",
			}),
			leaseExpiresAt: new Date("2026-08-21T12:05:00.000Z"),
		});
		const deletion = await worker(
			deletionRepository,
			store,
			keyRings,
		).runOnce();
		expect(deletion).toEqual({ kind: "ARTIFACT_DELETED", exportId });
		expect(store.objectState).toBe("TOMBSTONE");
		expect(deletionRepository.actions.at(-1)).toBe("mark-deleted");

		store.resumePausedPut();
		const staleResult = await staleBuild;
		expect(staleResult).toEqual({
			kind: "LEASE_LOST",
			exportId,
			phase: "BUILD",
		});
		expect(store.objectState).toBe("TOMBSTONE");
		expect(store.actions).toEqual(["put", "delete"]);
		expect(store.putBodyReference?.every((value) => value === 0)).toBe(true);

		buildRepository.stageCiphertext?.fill(0);
		store.putBodyCopy?.fill(0);
		destroyRings(keyRings);
	});

	it("classifies transient upload failure for retry and erases the body", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		repository.job = buildJob(exportId);
		repository.failResult = Object.freeze({
			status: "QUEUED",
			stateVersion: 9,
		});
		store.putError = new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");

		const result = await worker(repository, store, keyRings).runOnce();

		expect(result).toEqual({
			kind: "EXPORT_RETRY_SCHEDULED",
			exportId,
			failureCode: "ARTIFACT_UPLOAD_FAILED",
		});
		expect(repository.failureInput).toMatchObject({
			failureCode: "ARTIFACT_UPLOAD_FAILED",
			retryable: true,
		});
		expect(store.putBodyReference?.every((value) => value === 0)).toBe(true);

		repository.stageCiphertext?.fill(0);
		store.putBodyCopy?.fill(0);
		destroyRings(keyRings);
	});

	it("treats oversize/invalid source snapshots as fatal without uploading", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		repository.job = buildJob(exportId);

		const result = await worker(repository, store, keyRings, 64).runOnce();

		expect(result).toEqual({
			kind: "EXPORT_FAILED",
			exportId,
			failureCode: "SNAPSHOT_TOO_LARGE",
		});
		expect(repository.failureInput).toMatchObject({
			failureCode: "SNAPSHOT_TOO_LARGE",
			retryable: false,
		});
		expect(store.actions).toEqual([]);
		expect(repository.actions).not.toContain("stage");
		repository.stageCiphertext?.fill(0);
		destroyRings(keyRings);
	});

	it("deletes before marking and clears the claimed encrypted locator copy", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		const locator = `exports/v1/2026/08/${exportId}.json`;
		const encrypted = encryptExportArtifactLocator(locator, keyRings.locator);
		repository.deletion = Object.freeze({
			exportId,
			stateVersion: 4,
			locatorCiphertext: encrypted.ciphertext,
			locatorKeyVersion: encrypted.keyVersion,
			artifact: null,
			leaseExpiresAt: new Date("2026-08-21T12:05:00.000Z"),
		});

		const result = await worker(repository, store, keyRings).runOnce();

		expect(result).toEqual({ kind: "ARTIFACT_DELETED", exportId });
		expect(store.deleteLocator).toBe(locator);
		expect(repository.actions).toEqual([
			"claim-delete",
			"renew-delete",
			"renew-delete",
			"mark-deleted",
		]);
		expect(store.actions).toEqual(["delete"]);
		expect(
			repository.deletion.locatorCiphertext.every((value) => value === 0),
		).toBe(true);
		destroyRings(keyRings);
	});

	it("never deletes an authenticated locator belonging to another export", async () => {
		const repository = new FakeRepository();
		const store = new FakeArtifactStore();
		const keyRings = rings();
		const exportId = randomUUID();
		const otherExportId = randomUUID();
		const encrypted = encryptExportArtifactLocator(
			`exports/v1/2026/08/${otherExportId}.json`,
			keyRings.locator,
		);
		repository.deletion = Object.freeze({
			exportId,
			stateVersion: 4,
			locatorCiphertext: encrypted.ciphertext,
			locatorKeyVersion: encrypted.keyVersion,
			artifact: null,
			leaseExpiresAt: new Date("2026-08-21T12:05:00.000Z"),
		});

		await expect(
			worker(repository, store, keyRings).runOnce(),
		).resolves.toEqual({
			kind: "ARTIFACT_DELETE_BLOCKED",
			exportId,
		});
		expect(store.actions).toEqual([]);
		expect(repository.actions).toEqual(["claim-delete"]);
		destroyRings(keyRings);
	});

	it("keeps public failure classification stable and detail-free", () => {
		expect(
			classifyExportWorkerFailure(
				new ExportArtifactStoreError("INTEGRITY_MISMATCH"),
				"UPLOAD",
			),
		).toEqual({ failureCode: "ARTIFACT_VERIFY_FAILED", retryable: false });
		expect(
			classifyExportWorkerFailure(new Error("provider secret"), "SOURCE"),
		).toEqual({ failureCode: "SOURCE_READ_FAILED", retryable: false });
	});
});
