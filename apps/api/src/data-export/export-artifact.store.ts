import type { Readable } from "node:stream";

export const EXPORT_ARTIFACT_STORE = Symbol("EXPORT_ARTIFACT_STORE");

export const EXPORT_ARTIFACT_CONTENT_TYPE = "application/json" as const;

export interface StoredExportArtifact {
	readonly locator: string;
	readonly fileName: string;
	readonly contentType: typeof EXPORT_ARTIFACT_CONTENT_TYPE;
	readonly sizeBytes: number;
	readonly sha256Hex: string;
}

export interface OpenedExportArtifact {
	readonly stream: Readable;
	readonly contentType: typeof EXPORT_ARTIFACT_CONTENT_TYPE;
	readonly sizeBytes: number;
}

export interface PutExportArtifactInput {
	readonly exportId: string;
	readonly locator: string;
	readonly fileName: string;
	readonly body: Buffer;
}

export interface PlannedExportArtifact {
	readonly locator: string;
	readonly fileName: string;
}

export interface ExpectedExportArtifact {
	readonly sizeBytes: number;
	readonly sha256Hex: string;
	readonly contentType: typeof EXPORT_ARTIFACT_CONTENT_TYPE;
}

export abstract class ExportArtifactStore {
	abstract putArtifact(
		input: PutExportArtifactInput,
	): Promise<StoredExportArtifact>;
	abstract openArtifact(
		locator: string,
		expected: ExpectedExportArtifact,
	): Promise<OpenedExportArtifact>;
	/**
	 * Resolves only after the locator is permanently occupied by a fixed,
	 * non-personal tombstone whose server-side digest and storage controls were
	 * verified. Merely deleting the previous object is not a successful result.
	 */
	abstract deleteArtifact(locator: string): Promise<void>;
}

export type ExportArtifactStoreFailure =
	| "INVALID_ARTIFACT"
	| "CREDENTIAL_UNAVAILABLE"
	| "UPSTREAM_UNAVAILABLE"
	| "INTEGRITY_MISMATCH";

export class ExportArtifactStoreError extends Error {
	constructor(readonly failure: ExportArtifactStoreFailure) {
		super("数据导出工件存储暂不可用");
		this.name = "ExportArtifactStoreError";
	}
}
