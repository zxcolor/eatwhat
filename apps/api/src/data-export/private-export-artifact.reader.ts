import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { OnApplicationShutdown } from "@nestjs/common";
import type {
	ExportArtifactReader,
	ExportArtifactReadRequest,
	ExportArtifactReadResult,
} from "../auth/data-export-artifact.reader.js";
import {
	EXPORT_ARTIFACT_CONTENT_TYPE,
	type ExportArtifactStore,
	ExportArtifactStoreError,
} from "./export-artifact.store.js";
import type { ExportArtifactRuntimeConfig } from "./export-artifact-config.js";
import { decryptExportArtifactLocator } from "./export-artifact-crypto.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ABSOLUTE_MAXIMUM_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAXIMUM_CONCURRENT_VERIFIED_DOWNLOADS = 4;

export class PrivateExportArtifactReader
	implements ExportArtifactReader, OnApplicationShutdown
{
	private activeVerifiedDownloads = 0;

	constructor(
		private readonly config: ExportArtifactRuntimeConfig,
		private readonly store: ExportArtifactStore,
	) {
		if (!config.enabled || config.locatorKeyRing === null) {
			throw new Error("数据导出私有工件读取器未就绪");
		}
	}

	async open(
		request: ExportArtifactReadRequest,
	): Promise<ExportArtifactReadResult> {
		const releaseSlot = this.acquireVerifiedDownloadSlot();
		let slotTransferredToBody = false;
		let verifiedBody: Buffer | null = null;
		try {
			const maximumArtifactBytes = Math.min(
				this.config.maximumArtifactBytes,
				ABSOLUTE_MAXIMUM_ARTIFACT_BYTES,
			);
			if (
				request.expectedSizeBytes < 1 ||
				request.expectedSizeBytes > maximumArtifactBytes ||
				!SHA256_PATTERN.test(request.expectedSha256)
			) {
				throw new ExportArtifactStoreError("INVALID_ARTIFACT");
			}
			const locator = decryptExportArtifactLocator(
				request.locatorCiphertext,
				request.locatorKeyVersion,
				this.config.locatorKeyRing as NonNullable<
					ExportArtifactRuntimeConfig["locatorKeyRing"]
				>,
			);
			const opened = await this.store.openArtifact(locator, {
				contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
				sizeBytes: request.expectedSizeBytes,
				sha256Hex: request.expectedSha256,
			});
			let totalBytes = 0;
			verifiedBody = Buffer.allocUnsafe(request.expectedSizeBytes);
			try {
				if (
					opened.contentType !== EXPORT_ARTIFACT_CONTENT_TYPE ||
					opened.sizeBytes !== request.expectedSizeBytes
				) {
					throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
				}
				for await (const rawChunk of opened.stream) {
					let temporaryChunk: Buffer | null = null;
					let chunk: Uint8Array | null = null;
					if (typeof rawChunk === "string") {
						temporaryChunk = Buffer.from(rawChunk);
						chunk = temporaryChunk;
					} else if (rawChunk instanceof Uint8Array) {
						chunk = rawChunk;
					}
					if (chunk === null) {
						throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
					}
					try {
						const nextTotal = totalBytes + chunk.byteLength;
						if (
							nextTotal > request.expectedSizeBytes ||
							nextTotal > maximumArtifactBytes
						) {
							throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
						}
						verifiedBody.set(chunk, totalBytes);
						totalBytes = nextTotal;
					} finally {
						temporaryChunk?.fill(0);
					}
				}
				if (totalBytes !== request.expectedSizeBytes) {
					throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
				}
				const actual = createHash("sha256").update(verifiedBody).digest("hex");
				if (actual !== request.expectedSha256) {
					throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
				}
			} catch (error) {
				opened.stream.destroy();
				if (error instanceof ExportArtifactStoreError) throw error;
				throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
			}
			const body = new VerifiedArtifactReadable(verifiedBody, releaseSlot);
			verifiedBody = null;
			slotTransferredToBody = true;
			return Object.freeze({ body });
		} catch (error) {
			if (error instanceof ExportArtifactStoreError) throw error;
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		} finally {
			verifiedBody?.fill(0);
			if (!slotTransferredToBody) releaseSlot();
		}
	}

	private acquireVerifiedDownloadSlot(): () => void {
		if (this.activeVerifiedDownloads >= MAXIMUM_CONCURRENT_VERIFIED_DOWNLOADS) {
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
		this.activeVerifiedDownloads += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeVerifiedDownloads -= 1;
		};
	}

	onApplicationShutdown(): void {
		this.config.locatorKeyRing?.destroy();
	}
}

class VerifiedArtifactReadable extends Readable {
	private emitted = false;
	private finalized = false;
	private transportDestination: NodeJS.WritableStream | null = null;

	constructor(
		private verifiedBody: Buffer | null,
		private readonly releaseSlot: () => void,
	) {
		super();
		this.once("end", () => this.finalizeWithoutTransport());
		this.once("close", () => this.finalizeWithoutTransport());
	}

	override _read(): void {
		if (this.emitted) return;
		this.emitted = true;
		this.push(this.verifiedBody);
		this.push(null);
	}

	override pipe<T extends NodeJS.WritableStream>(
		destination: T,
		options?: { end?: boolean },
	): T {
		if (this.transportDestination !== null) {
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
		if (options?.end === false || destinationUnavailable(destination)) {
			this.finalize();
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
		this.transportDestination = destination;
		const settled = () => {
			destination.removeListener("finish", settled);
			destination.removeListener("close", settled);
			destination.removeListener("error", settled);
			if (this.transportDestination === destination) {
				this.transportDestination = null;
			}
			this.finalize();
		};
		destination.once("finish", settled);
		destination.once("close", settled);
		destination.once("error", settled);
		if (destinationUnavailable(destination)) {
			settled();
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
		try {
			return super.pipe(destination, options);
		} catch (error) {
			settled();
			throw error;
		}
	}

	override _destroy(
		error: Error | null,
		callback: (error?: Error | null) => void,
	): void {
		this.finalizeWithoutTransport();
		callback(error);
	}

	private finalizeWithoutTransport(): void {
		if (this.transportDestination === null) this.finalize();
	}

	private finalize(): void {
		if (this.finalized) return;
		this.finalized = true;
		this.verifiedBody?.fill(0);
		this.verifiedBody = null;
		this.releaseSlot();
	}
}

interface WritableDestinationLifecycle {
	readonly destroyed?: boolean;
	readonly closed?: boolean;
	readonly writableEnded?: boolean;
	readonly writableFinished?: boolean;
	readonly writableAborted?: boolean;
	readonly errored?: unknown;
}

function destinationUnavailable(destination: NodeJS.WritableStream): boolean {
	try {
		const state = destination as NodeJS.WritableStream &
			WritableDestinationLifecycle;
		return (
			state.destroyed === true ||
			state.closed === true ||
			state.writableEnded === true ||
			state.writableFinished === true ||
			state.writableAborted === true ||
			(state.errored !== null && state.errored !== undefined)
		);
	} catch {
		return true;
	}
}
