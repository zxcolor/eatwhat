import type { Readable } from "node:stream";

export const EXPORT_ARTIFACT_READER = Symbol("EXPORT_ARTIFACT_READER");

/**
 * Internal-only authorization produced after the database has rechecked owner,
 * READY state, expiry and deletion state. No field from this object may enter a
 * public DTO, exception body or log.
 */
export interface ExportArtifactReadRequest {
	readonly locatorCiphertext: Buffer;
	readonly locatorKeyVersion: string;
	readonly expectedSizeBytes: number;
	readonly expectedSha256: string;
}

export interface ExportArtifactReadResult {
	readonly body: Readable;
}

export interface ExportArtifactReader {
	open(request: ExportArtifactReadRequest): Promise<ExportArtifactReadResult>;
}

/** Fail-closed default until a private artifact-store adapter is configured. */
export class UnavailableExportArtifactReader implements ExportArtifactReader {
	async open(_request: ExportArtifactReadRequest): Promise<never> {
		throw new Error("data export artifact reader is unavailable");
	}
}
