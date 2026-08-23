import {
	createHash,
	createHmac,
	randomBytes as systemRandomBytes,
} from "node:crypto";
import type { SupportFeedbackKeyRing } from "../support-feedback/support-feedback-crypto.js";
import { planExportArtifact } from "./aliyun-oss-export-artifact.store.js";
import {
	EXPORT_ARTIFACT_CONTENT_TYPE,
	type ExportArtifactStore,
	ExportArtifactStoreError,
	type OpenedExportArtifact,
	type PlannedExportArtifact,
	type StoredExportArtifact,
} from "./export-artifact.store.js";
import {
	decryptExportArtifactLocator,
	type ExportLocatorKeyRing,
	encryptExportArtifactLocator,
} from "./export-artifact-crypto.js";
import {
	ExportSnapshotError,
	serializeExportSnapshot,
} from "./export-snapshot.js";
import {
	type ClaimedArtifactDeletion,
	type ClaimedExportJob,
	type DataExportWorkerRepository,
	DataExportWorkerRepositoryError,
	type ExportWorkerFailureCode,
	type ExportWorkerLeaseIdentity,
} from "./export-worker.repository.js";

const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROCESS_ENTROPY_BYTES = 32;
const LEASE_HMAC_KEY_BYTES = 32;
const DATABASE_ARTIFACT_LIMIT_BYTES = 10 * 1024 * 1024;
const LEASE_IDENTITY_DOMAIN = Buffer.from(
	"chi-shen-me:data-export:worker-lease:v1\u0000",
	"utf8",
);

interface FrozenArtifactExpectation {
	readonly sha256Hex: string;
	readonly sizeBytes: number;
	readonly contentType: typeof EXPORT_ARTIFACT_CONTENT_TYPE;
}

export interface DataExportWorkerOptions {
	readonly leaseSeconds: number;
	readonly maximumArtifactBytes: number;
	readonly now?: () => Date;
}

export type ExportWorkerRunResult =
	| { readonly kind: "IDLE" }
	| { readonly kind: "EXPORT_READY"; readonly exportId: string }
	| {
			readonly kind: "EXPORT_RETRY_SCHEDULED";
			readonly exportId: string;
			readonly failureCode: ExportWorkerFailureCode;
	  }
	| {
			readonly kind: "EXPORT_FAILED";
			readonly exportId: string;
			readonly failureCode: ExportWorkerFailureCode;
	  }
	| {
			readonly kind: "LEASE_LOST";
			readonly exportId: string;
			readonly phase: "BUILD" | "DELETE";
	  }
	| {
			readonly kind: "STATE_UNCONFIRMED";
			readonly exportId: string | null;
			readonly phase: "CLAIM" | "STAGE" | "BUILD" | "COMPLETE" | "DELETE";
	  }
	| { readonly kind: "ARTIFACT_DELETED"; readonly exportId: string }
	| {
			readonly kind: "ARTIFACT_DELETE_RETRY_REQUIRED";
			readonly exportId: string;
	  }
	| {
			readonly kind: "ARTIFACT_DELETE_BLOCKED";
			readonly exportId: string;
	  };

export interface ClassifiedExportWorkerFailure {
	readonly failureCode: ExportWorkerFailureCode;
	readonly retryable: boolean;
}

export type ExportWorkerFailurePhase =
	| "SOURCE"
	| "SERIALIZE"
	| "UPLOAD"
	| "VERIFY"
	| "INTERNAL";

/**
 * Creates one opaque identity for the lifetime of a worker process. The random
 * nonce and HMAC key are zeroed before return; PostgreSQL receives only the
 * domain-separated digest and the non-secret rotation version.
 */
export function createExportWorkerLeaseIdentity(
	hashKeyVersion: string,
	hmacKey: Uint8Array,
	randomBytes: (size: number) => Uint8Array = systemRandomBytes,
): ExportWorkerLeaseIdentity {
	if (!KEY_VERSION_PATTERN.test(hashKeyVersion)) {
		throw new Error("数据导出工作器租约密钥版本格式无效");
	}
	if (hmacKey.byteLength !== LEASE_HMAC_KEY_BYTES) {
		throw new Error("数据导出工作器租约HMAC密钥必须为32字节");
	}
	const key = Buffer.from(hmacKey);
	let generatedEntropy: Uint8Array | null = null;
	let entropy: Buffer | null = null;
	try {
		generatedEntropy = randomBytes(PROCESS_ENTROPY_BYTES);
		entropy = Buffer.from(generatedEntropy);
		if (entropy.byteLength !== PROCESS_ENTROPY_BYTES) {
			throw new Error("数据导出工作器进程随机标识长度无效");
		}
		return Object.freeze({
			workerHash: createHmac("sha256", key)
				.update(LEASE_IDENTITY_DOMAIN)
				.update(entropy)
				.digest("hex"),
			hashKeyVersion,
		});
	} finally {
		key.fill(0);
		entropy?.fill(0);
		generatedEntropy?.fill(0);
	}
}

export function classifyExportWorkerFailure(
	error: unknown,
	phase: ExportWorkerFailurePhase,
): ClassifiedExportWorkerFailure {
	if (phase === "SERIALIZE") {
		return Object.freeze({
			failureCode:
				error instanceof ExportSnapshotError &&
				error.failure === "SNAPSHOT_TOO_LARGE"
					? "SNAPSHOT_TOO_LARGE"
					: "SOURCE_READ_FAILED",
			retryable: false,
		});
	}
	if (phase === "UPLOAD" && error instanceof ExportArtifactStoreError) {
		if (
			error.failure === "CREDENTIAL_UNAVAILABLE" ||
			error.failure === "UPSTREAM_UNAVAILABLE"
		) {
			return Object.freeze({
				failureCode: "ARTIFACT_UPLOAD_FAILED" as const,
				retryable: true,
			});
		}
		if (error.failure === "INTEGRITY_MISMATCH") {
			return Object.freeze({
				failureCode: "ARTIFACT_VERIFY_FAILED" as const,
				retryable: false,
			});
		}
		return Object.freeze({
			failureCode: "INTERNAL_ERROR" as const,
			retryable: false,
		});
	}
	if (phase === "VERIFY") {
		return Object.freeze({
			failureCode: "ARTIFACT_VERIFY_FAILED" as const,
			retryable: false,
		});
	}
	if (phase === "SOURCE") {
		return Object.freeze({
			failureCode:
				error instanceof DataExportWorkerRepositoryError &&
				error.failure === "SNAPSHOT_TOO_LARGE"
					? ("SNAPSHOT_TOO_LARGE" as const)
					: ("SOURCE_READ_FAILED" as const),
			retryable:
				error instanceof DataExportWorkerRepositoryError &&
				error.failure === "DATABASE_UNAVAILABLE",
		});
	}
	return Object.freeze({
		failureCode: "INTERNAL_ERROR" as const,
		retryable:
			error instanceof DataExportWorkerRepositoryError &&
			error.failure === "DATABASE_UNAVAILABLE",
	});
}

export class DataExportWorker {
	readonly #now: () => Date;

	constructor(
		private readonly repository: DataExportWorkerRepository,
		private readonly artifactStore: ExportArtifactStore,
		private readonly locatorKeyRing: ExportLocatorKeyRing,
		private readonly supportFeedbackKeyRing: SupportFeedbackKeyRing,
		private readonly identity: ExportWorkerLeaseIdentity,
		private readonly options: DataExportWorkerOptions,
	) {
		if (
			!Number.isInteger(options.leaseSeconds) ||
			options.leaseSeconds < 30 ||
			options.leaseSeconds > 900
		) {
			throw new Error("数据导出工作器租约必须为30到900秒");
		}
		if (
			!Number.isSafeInteger(options.maximumArtifactBytes) ||
			options.maximumArtifactBytes < 1 ||
			options.maximumArtifactBytes > DATABASE_ARTIFACT_LIMIT_BYTES
		) {
			throw new Error("数据导出工作器工件大小上限无效");
		}
		if (
			!/^[0-9a-f]{64}$/u.test(identity.workerHash) ||
			!KEY_VERSION_PATTERN.test(identity.hashKeyVersion)
		) {
			throw new Error("数据导出工作器租约身份无效");
		}
		this.#now = options.now ?? (() => new Date());
	}

	/**
	 * Performs at most one deletion or one build. Expired/private object cleanup
	 * has priority so account deletion is not held behind fresh export work.
	 */
	async runOnce(): Promise<ExportWorkerRunResult> {
		let deletion: ClaimedArtifactDeletion | null;
		try {
			deletion = await this.repository.claimNextArtifactDeletion(
				this.identity,
				this.options.leaseSeconds,
			);
		} catch {
			return Object.freeze({
				kind: "STATE_UNCONFIRMED" as const,
				exportId: null,
				phase: "CLAIM" as const,
			});
		}
		if (deletion !== null) return this.deleteArtifact(deletion);

		let job: ClaimedExportJob | null;
		try {
			job = await this.repository.claimNextJob(
				this.identity,
				this.options.leaseSeconds,
			);
		} catch {
			return Object.freeze({
				kind: "STATE_UNCONFIRMED" as const,
				exportId: null,
				phase: "CLAIM" as const,
			});
		}
		return job === null
			? Object.freeze({ kind: "IDLE" as const })
			: this.build(job);
	}

	private async build(job: ClaimedExportJob): Promise<ExportWorkerRunResult> {
		let locatorCiphertext: Buffer | null = null;
		let body: Buffer | null = null;
		let locator: string;
		let stateVersion = job.stateVersion;
		let planned: PlannedExportArtifact;
		let frozen: FrozenArtifactExpectation | null = null;

		try {
			planned = planExportArtifact(job.exportId, this.currentTime());
			if (job.stagedArtifact !== null) {
				locatorCiphertext = Buffer.from(job.stagedArtifact.locatorCiphertext);
				locator = decryptExportArtifactLocator(
					locatorCiphertext,
					job.stagedArtifact.locatorKeyVersion,
					this.locatorKeyRing,
				);
				assertLocatorBelongsToExport(locator, job.exportId);
				frozen = Object.freeze({
					sha256Hex: job.stagedArtifact.sha256Hex,
					sizeBytes: job.stagedArtifact.sizeBytes,
					contentType: job.stagedArtifact.contentType,
				});

				const beforeOpen = await this.renewBuildLease(
					job.exportId,
					stateVersion,
				);
				if (typeof beforeOpen !== "number") return beforeOpen;
				stateVersion = beforeOpen;

				try {
					if (await this.existingArtifactMatches(locator, frozen)) {
						return await this.completeFrozenJob(job.exportId, stateVersion);
					}
				} catch (error) {
					return await this.fail(
						job.exportId,
						stateVersion,
						classifyExportWorkerFailure(error, "VERIFY"),
					);
				}
			} else {
				locator = planned.locator;
			}

			const beforeSnapshot = await this.renewBuildLease(
				job.exportId,
				stateVersion,
			);
			if (typeof beforeSnapshot !== "number") return beforeSnapshot;
			stateVersion = beforeSnapshot;

			let source: unknown;
			try {
				source = await this.repository.buildSafeSnapshot(
					job.exportId,
					this.identity,
				);
			} catch (error) {
				return await this.fail(
					job.exportId,
					stateVersion,
					classifyExportWorkerFailure(error, "SOURCE"),
				);
			}

			try {
				body = serializeExportSnapshot(
					source,
					this.supportFeedbackKeyRing,
					this.options.maximumArtifactBytes,
				).body;
				source = null;
			} catch (error) {
				source = null;
				return await this.fail(
					job.exportId,
					stateVersion,
					classifyExportWorkerFailure(error, "SERIALIZE"),
				);
			}

			const derived = Object.freeze({
				sha256Hex: createHash("sha256").update(body).digest("hex"),
				sizeBytes: body.byteLength,
				contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
			});
			if (frozen === null) {
				const encrypted = encryptExportArtifactLocator(
					locator,
					this.locatorKeyRing,
				);
				locatorCiphertext = encrypted.ciphertext;
				const beforeStage = await this.renewBuildLease(
					job.exportId,
					stateVersion,
				);
				if (typeof beforeStage !== "number") return beforeStage;
				stateVersion = beforeStage;
				try {
					const staged = await this.repository.stageArtifact({
						exportId: job.exportId,
						identity: this.identity,
						expectedStateVersion: stateVersion,
						locatorCiphertext,
						locatorKeyVersion: encrypted.keyVersion,
						artifactSha256Hex: derived.sha256Hex,
						artifactSizeBytes: derived.sizeBytes,
						artifactContentType: derived.contentType,
					});
					if (staged === null) return lostLease(job.exportId, "BUILD");
					stateVersion = staged.stateVersion;
					frozen = derived;
				} catch {
					// Staging is the durability boundary. An ambiguous response must not
					// be followed by PUT; a later fenced claimant will discover the row.
					return Object.freeze({
						kind: "STATE_UNCONFIRMED" as const,
						exportId: job.exportId,
						phase: "STAGE" as const,
					});
				}
			} else if (!artifactExpectationEquals(frozen, derived)) {
				return await this.fail(
					job.exportId,
					stateVersion,
					classifyExportWorkerFailure(null, "VERIFY"),
				);
			}

			const beforeUpload = await this.renewBuildLease(
				job.exportId,
				stateVersion,
			);
			if (typeof beforeUpload !== "number") return beforeUpload;
			stateVersion = beforeUpload;

			let stored: StoredExportArtifact;
			try {
				stored = await this.artifactStore.putArtifact({
					exportId: job.exportId,
					locator,
					fileName: planned.fileName,
					body,
				});
			} catch (error) {
				return await this.fail(
					job.exportId,
					stateVersion,
					classifyExportWorkerFailure(error, "UPLOAD"),
				);
			}

			const artifactInvalid =
				stored.locator !== locator ||
				stored.fileName !== planned.fileName ||
				!artifactExpectationEquals(frozen, stored);
			if (artifactInvalid) {
				return await this.fail(
					job.exportId,
					stateVersion,
					classifyExportWorkerFailure(null, "VERIFY"),
				);
			}

			return await this.completeFrozenJob(job.exportId, stateVersion);
		} finally {
			body?.fill(0);
			job.stagedArtifact?.locatorCiphertext.fill(0);
			locatorCiphertext?.fill(0);
		}
	}

	private async existingArtifactMatches(
		locator: string,
		expected: FrozenArtifactExpectation,
	): Promise<boolean> {
		let opened: OpenedExportArtifact;
		try {
			opened = await this.artifactStore.openArtifact(locator, expected);
		} catch (error) {
			if (
				error instanceof ExportArtifactStoreError &&
				(error.failure === "CREDENTIAL_UNAVAILABLE" ||
					error.failure === "UPSTREAM_UNAVAILABLE")
			) {
				return false;
			}
			throw error;
		}
		if (
			opened.contentType !== expected.contentType ||
			opened.sizeBytes !== expected.sizeBytes
		) {
			opened.stream.destroy();
			throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
		}

		const hash = createHash("sha256");
		let sizeBytes = 0;
		try {
			for await (const chunk of opened.stream) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				sizeBytes += bytes.byteLength;
				if (sizeBytes > expected.sizeBytes) {
					opened.stream.destroy();
					throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
				}
				hash.update(bytes);
			}
		} catch (error) {
			if (error instanceof ExportArtifactStoreError) throw error;
			// A transport failure leaves object existence unknown. Rebuilding is
			// permitted only if it reproduces the already frozen bytes exactly.
			return false;
		}
		if (
			sizeBytes !== expected.sizeBytes ||
			hash.digest("hex") !== expected.sha256Hex
		) {
			throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
		}
		return true;
	}

	private async completeFrozenJob(
		exportId: string,
		stateVersion: number,
	): Promise<ExportWorkerRunResult> {
		const beforeComplete = await this.renewBuildLease(exportId, stateVersion);
		if (typeof beforeComplete !== "number") return beforeComplete;
		try {
			const completed = await this.repository.completeJob({
				exportId,
				identity: this.identity,
				expectedStateVersion: beforeComplete,
			});
			if (completed === null) return lostLease(exportId, "BUILD");
			return Object.freeze({ kind: "EXPORT_READY" as const, exportId });
		} catch {
			// Either READY committed or the fully staged row remains discoverable.
			return Object.freeze({
				kind: "STATE_UNCONFIRMED" as const,
				exportId,
				phase: "COMPLETE" as const,
			});
		}
	}

	private async renewBuildLease(
		exportId: string,
		stateVersion: number,
	): Promise<number | ExportWorkerRunResult> {
		try {
			const renewed = await this.repository.renewLease(
				exportId,
				this.identity,
				stateVersion,
				this.options.leaseSeconds,
			);
			if (renewed === null || renewed.purpose !== "BUILD") {
				return lostLease(exportId, "BUILD");
			}
			return renewed.stateVersion;
		} catch {
			return Object.freeze({
				kind: "STATE_UNCONFIRMED" as const,
				exportId,
				phase: "BUILD" as const,
			});
		}
	}

	private async fail(
		exportId: string,
		stateVersion: number,
		failure: ClassifiedExportWorkerFailure,
	): Promise<ExportWorkerRunResult> {
		try {
			const failed = await this.repository.failJob({
				exportId,
				identity: this.identity,
				expectedStateVersion: stateVersion,
				failureCode: failure.failureCode,
				retryable: failure.retryable,
			});
			if (failed === null) return lostLease(exportId, "BUILD");
			return Object.freeze({
				kind:
					failed.status === "QUEUED"
						? ("EXPORT_RETRY_SCHEDULED" as const)
						: ("EXPORT_FAILED" as const),
				exportId,
				failureCode: failure.failureCode,
			});
		} catch {
			return Object.freeze({
				kind: "STATE_UNCONFIRMED" as const,
				exportId,
				phase: "BUILD" as const,
			});
		}
	}

	private async deleteArtifact(
		deletion: ClaimedArtifactDeletion,
	): Promise<ExportWorkerRunResult> {
		let stateVersion = deletion.stateVersion;
		try {
			let locator: string;
			try {
				locator = decryptExportArtifactLocator(
					deletion.locatorCiphertext,
					deletion.locatorKeyVersion,
					this.locatorKeyRing,
				);
				assertLocatorBelongsToExport(locator, deletion.exportId);
			} catch {
				return Object.freeze({
					kind: "ARTIFACT_DELETE_BLOCKED" as const,
					exportId: deletion.exportId,
				});
			}

			const beforeDelete = await this.renewDeleteLease(
				deletion.exportId,
				stateVersion,
			);
			if (typeof beforeDelete !== "number") return beforeDelete;
			stateVersion = beforeDelete;

			try {
				await this.artifactStore.deleteArtifact(locator);
			} catch (error) {
				return Object.freeze({
					kind:
						error instanceof ExportArtifactStoreError &&
						error.failure === "INVALID_ARTIFACT"
							? ("ARTIFACT_DELETE_BLOCKED" as const)
							: ("ARTIFACT_DELETE_RETRY_REQUIRED" as const),
					exportId: deletion.exportId,
				});
			}

			const beforeMark = await this.renewDeleteLease(
				deletion.exportId,
				stateVersion,
			);
			if (typeof beforeMark !== "number") return beforeMark;
			stateVersion = beforeMark;

			try {
				const marked = await this.repository.markArtifactDeleted(
					deletion.exportId,
					this.identity,
					stateVersion,
				);
				if (marked === null) return lostLease(deletion.exportId, "DELETE");
				return Object.freeze({
					kind: "ARTIFACT_DELETED" as const,
					exportId: deletion.exportId,
				});
			} catch {
				return Object.freeze({
					kind: "STATE_UNCONFIRMED" as const,
					exportId: deletion.exportId,
					phase: "DELETE" as const,
				});
			}
		} finally {
			deletion.locatorCiphertext.fill(0);
		}
	}

	private async renewDeleteLease(
		exportId: string,
		stateVersion: number,
	): Promise<number | ExportWorkerRunResult> {
		try {
			const renewed = await this.repository.renewLease(
				exportId,
				this.identity,
				stateVersion,
				this.options.leaseSeconds,
			);
			if (renewed === null || renewed.purpose !== "DELETE") {
				return lostLease(exportId, "DELETE");
			}
			return renewed.stateVersion;
		} catch {
			return Object.freeze({
				kind: "STATE_UNCONFIRMED" as const,
				exportId,
				phase: "DELETE" as const,
			});
		}
	}

	private currentTime(): Date {
		const current = this.#now();
		if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
			throw new Error("数据导出工作器时钟无效");
		}
		return new Date(current.getTime());
	}
}

function assertLocatorBelongsToExport(locator: string, exportId: string): void {
	if (!UUID_PATTERN.test(exportId) || !locator.endsWith(`/${exportId}.json`)) {
		throw new Error("导出定位符与任务不匹配");
	}
}

function artifactExpectationEquals(
	expected: FrozenArtifactExpectation,
	actual: FrozenArtifactExpectation,
): boolean {
	return (
		expected.sha256Hex === actual.sha256Hex &&
		expected.sizeBytes === actual.sizeBytes &&
		expected.contentType === actual.contentType
	);
}

function lostLease(
	exportId: string,
	phase: "BUILD" | "DELETE",
): ExportWorkerRunResult {
	return Object.freeze({ kind: "LEASE_LOST" as const, exportId, phase });
}
