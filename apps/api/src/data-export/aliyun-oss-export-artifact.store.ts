import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import CredentialPackage, {
	Config as CredentialConfig,
} from "@alicloud/credentials";
import OssPackage from "ali-oss";
import {
	EXPORT_ARTIFACT_CONTENT_TYPE,
	type ExpectedExportArtifact,
	ExportArtifactStore,
	ExportArtifactStoreError,
	type OpenedExportArtifact,
	type PlannedExportArtifact,
	type PutExportArtifactInput,
	type StoredExportArtifact,
} from "./export-artifact.store.js";
import type { ExportArtifactRuntimeConfig } from "./export-artifact-config.js";
import { assertExportArtifactLocator } from "./export-artifact-crypto.js";

const EXPORT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TOMBSTONE_CONTENT_TYPE =
	"application/vnd.chi-shen-me.export-tombstone+json";
const TOMBSTONE_CACHE_CONTROL = "private, no-store, max-age=0";
const TOMBSTONE_KIND = "chi-shen-me-export-tombstone-v1";
const TOMBSTONE_BODY = Buffer.from(
	'{"kind":"chi-shen-me-export-tombstone","schemaVersion":1}\n',
	"utf8",
);
const TOMBSTONE_MD5_BASE64 = createHash("md5")
	.update(TOMBSTONE_BODY)
	.digest("base64");
const TOMBSTONE_MD5_HEX = createHash("md5")
	.update(TOMBSTONE_BODY)
	.digest("hex");
const TOMBSTONE_REPLACEMENT_ATTEMPTS = 5;

interface CredentialModel {
	readonly accessKeyId?: string;
	readonly accessKeySecret?: string;
	readonly securityToken?: string;
	readonly type?: string;
}

interface CredentialLike {
	getCredential(): Promise<CredentialModel>;
}

interface OssResponse {
	readonly status: number;
	readonly headers: object;
}

interface OssClientLike {
	getBucketVersioning?(
		name: string,
		options: { readonly timeout: number },
	): Promise<{
		readonly status: number;
		readonly versionStatus?: string | null;
		readonly res: OssResponse;
	}>;
	getBucketLifecycle?(
		name: string,
		options: { readonly timeout: number },
	): Promise<{
		readonly rules?: readonly unknown[] | null;
		readonly res: OssResponse;
	}>;
	put(
		name: string,
		body: Buffer,
		options: {
			readonly timeout: number;
			readonly mime: string;
			readonly headers: object;
		},
	): Promise<{ readonly res: OssResponse }>;
	head(
		name: string,
		options: { readonly timeout: number },
	): Promise<{ readonly res: OssResponse }>;
	getStream(
		name: string,
		options: { readonly timeout: number },
	): Promise<{ readonly stream?: Readable; readonly res: OssResponse }>;
	delete(
		name: string,
		options: { readonly timeout: number },
	): Promise<{ readonly res: OssResponse }>;
}

export interface AliyunOssArtifactDependencies {
	createCredential(config: ExportArtifactRuntimeConfig): CredentialLike;
	createClient(
		config: ExportArtifactRuntimeConfig,
		credential: CredentialLike,
		initial: CredentialModel,
	): OssClientLike;
}

function resolveCommonJsConstructor<T>(value: unknown): T {
	if (typeof value === "function") return value as T;
	if (typeof value === "object" && value !== null && "default" in value) {
		return resolveCommonJsConstructor<T>(
			(value as { readonly default?: unknown }).default,
		);
	}
	throw new Error("阿里云OSS官方SDK导出不可用");
}

const CredentialConstructor =
	resolveCommonJsConstructor<typeof CredentialPackage.default>(
		CredentialPackage,
	);
const OssConstructor =
	resolveCommonJsConstructor<typeof OssPackage>(OssPackage);

const OFFICIAL_DEPENDENCIES: AliyunOssArtifactDependencies = Object.freeze({
	createCredential: (config: ExportArtifactRuntimeConfig) =>
		new CredentialConstructor(
			new CredentialConfig({
				type: "ecs_ram_role",
				roleName: config.ramRoleName,
				disableIMDSv1: config.disableImdsV1,
				enableIMDSv2: config.enableImdsV2,
				timeout: config.credentialTimeoutMs,
				connectTimeout: config.credentialTimeoutMs,
			}),
		),
	createClient: (
		config: ExportArtifactRuntimeConfig,
		credential: CredentialLike,
		initial: CredentialModel,
	) =>
		new OssConstructor({
			accessKeyId: initial.accessKeyId as string,
			accessKeySecret: initial.accessKeySecret as string,
			...(initial.securityToken === undefined
				? {}
				: { stsToken: initial.securityToken }),
			bucket: config.bucket,
			region: config.region,
			internal: config.internal,
			secure: true,
			authorizationV4: true,
			timeout: config.timeoutMs,
			refreshSTSTokenInterval: 5 * 60 * 1000,
			refreshSTSToken: async () => {
				const refreshed = await credential.getCredential();
				if (!usableCredential(refreshed)) {
					throw new ExportArtifactStoreError("CREDENTIAL_UNAVAILABLE");
				}
				return {
					accessKeyId: refreshed.accessKeyId,
					accessKeySecret: refreshed.accessKeySecret,
					stsToken: refreshed.securityToken ?? "",
				};
			},
		}),
});

export async function createAliyunOssExportArtifactStore(
	config: ExportArtifactRuntimeConfig,
	dependencies: AliyunOssArtifactDependencies = OFFICIAL_DEPENDENCIES,
): Promise<AliyunOssExportArtifactStore | null> {
	if (!config.enabled) return null;
	let timer: NodeJS.Timeout | undefined;
	let credential: CredentialLike;
	let initial: CredentialModel;
	try {
		credential = dependencies.createCredential(config);
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new ExportArtifactStoreError("CREDENTIAL_UNAVAILABLE")),
				config.credentialTimeoutMs,
			);
			timer.unref();
		});
		initial = await Promise.race([credential.getCredential(), timeout]);
		if (!usableCredential(initial)) {
			throw new ExportArtifactStoreError("CREDENTIAL_UNAVAILABLE");
		}
	} catch {
		throw new ExportArtifactStoreError("CREDENTIAL_UNAVAILABLE");
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	try {
		const store = new AliyunOssExportArtifactStore(
			config,
			dependencies.createClient(config, credential, initial),
		);
		await store.assertReady();
		return store;
	} catch (error) {
		if (error instanceof ExportArtifactStoreError) throw error;
		throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
	}
}

export class AliyunOssExportArtifactStore extends ExportArtifactStore {
	constructor(
		private readonly config: ExportArtifactRuntimeConfig,
		private readonly client: OssClientLike,
	) {
		super();
	}

	async assertReady(): Promise<void> {
		try {
			if (
				this.client.getBucketVersioning === undefined ||
				this.client.getBucketLifecycle === undefined
			) {
				throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
			}
			const versioning = await this.client.getBucketVersioning(
				this.config.bucket,
				{ timeout: this.config.timeoutMs },
			);
			// OSS represents a bucket that has never enabled versioning by omitting
			// Status (the SDK/parser may surface the empty XML value as null or "").
			const versionStatus = versioning.versionStatus;
			const versioningNeverEnabled =
				versionStatus === undefined ||
				versionStatus === null ||
				versionStatus === "";
			if (
				versioning.status !== 200 ||
				versioning.res.status !== 200 ||
				!versioningNeverEnabled
			) {
				throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
			}

			try {
				await this.client.getBucketLifecycle(
					this.config.bucket,
					{ timeout: this.config.timeoutMs },
				);
				// A configured lifecycle request returns 200. Even an empty or disabled
				// rule set is rejected because it is not the official signal for a bucket
				// that has never had lifecycle configuration.
				throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
			} catch (error) {
				// OSS reports a bucket without lifecycle configuration as the exact
				// NoSuchLifecycle 404. Any other error or any configured rule is unsafe:
				// a future expiration could remove the permanent deletion tombstone and
				// reopen the stale-writer window.
				if (!isMissingBucketLifecycle(error)) throw error;
			}
		} catch (error) {
			if (error instanceof ExportArtifactStoreError) throw error;
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
	}

	async putArtifact(
		input: PutExportArtifactInput,
	): Promise<StoredExportArtifact> {
		if (
			!EXPORT_ID_PATTERN.test(input.exportId) ||
			input.fileName !== `chi-shen-me-data-export-${input.exportId}.json` ||
			input.body.byteLength < 1 ||
			input.body.byteLength > this.config.maximumArtifactBytes
		) {
			throw new ExportArtifactStoreError("INVALID_ARTIFACT");
		}
		assertExportArtifactLocator(input.locator);
		if (!input.locator.endsWith(`/${input.exportId}.json`)) {
			throw new ExportArtifactStoreError("INVALID_ARTIFACT");
		}
		const sha256Hex = createHash("sha256").update(input.body).digest("hex");
		const contentMd5 = createHash("md5").update(input.body).digest("base64");
		const contentMd5Hex = createHash("md5").update(input.body).digest("hex");
		const expectedDisposition = `attachment; filename="${input.fileName}"`;
		try {
			try {
				const response = await this.client.put(input.locator, input.body, {
					timeout: this.config.timeoutMs,
					mime: EXPORT_ARTIFACT_CONTENT_TYPE,
					headers: {
						"Cache-Control": "private, no-store, max-age=0",
						"Content-MD5": contentMd5,
						"Content-Disposition": `attachment; filename="${input.fileName}"`,
						"x-oss-forbid-overwrite": "true",
						"x-oss-object-acl": "private",
						"x-oss-meta-sha256": sha256Hex,
						"x-oss-server-side-encryption": "AES256",
					},
				});
				if (response.res.status !== 200) {
					throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
				}
			} catch (error) {
				// A retry after an ambiguous network response may find the immutable
				// deterministic object already present. Only OSS's exact no-overwrite
				// conflict is eligible for HEAD verification; every other failure is
				// sanitized and retried by the fenced worker.
				if (!isForbidOverwriteConflict(error)) throw error;
			}
			await this.verifyStoredArtifact(input.locator, {
				sizeBytes: input.body.byteLength,
				sha256Hex,
				contentMd5,
				contentMd5Hex,
				expectedDisposition,
			});
			return Object.freeze({
				locator: input.locator,
				fileName: input.fileName,
				contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
				sizeBytes: input.body.byteLength,
				sha256Hex,
			});
		} catch (error) {
			if (error instanceof ExportArtifactStoreError) throw error;
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
	}

	private async verifyStoredArtifact(
		locator: string,
		expected: {
			readonly sizeBytes: number;
			readonly sha256Hex: string;
			readonly contentMd5: string;
			readonly contentMd5Hex: string;
			readonly expectedDisposition: string;
		},
	): Promise<void> {
		const verified = await this.client.head(locator, {
			timeout: this.config.timeoutMs,
		});
		const serverContentMd5 = textHeader(verified.res.headers, "content-md5");
		if (
			verified.res.status !== 200 ||
			numericHeader(verified.res.headers, "content-length") !==
				expected.sizeBytes ||
			textHeader(verified.res.headers, "content-type") !==
				EXPORT_ARTIFACT_CONTENT_TYPE ||
			textHeader(verified.res.headers, "cache-control") !==
				"private, no-store, max-age=0" ||
			textHeader(verified.res.headers, "content-disposition") !==
				expected.expectedDisposition ||
			textHeader(verified.res.headers, "x-oss-meta-sha256") !==
				expected.sha256Hex ||
			textHeader(verified.res.headers, "x-oss-server-side-encryption") !==
				"AES256" ||
			(serverContentMd5 !== null && serverContentMd5 !== expected.contentMd5)
		) {
			throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
		}
		const etag = normalizeMd5Etag(textHeader(verified.res.headers, "etag"));
		if (
			serverContentMd5 === expected.contentMd5 ||
			etag === expected.contentMd5Hex
		) {
			return;
		}
		await this.verifyStoredBodyByDownload(locator, expected);
	}

	private async verifyStoredBodyByDownload(
		locator: string,
		expected: {
			readonly sizeBytes: number;
			readonly sha256Hex: string;
			readonly contentMd5: string;
		},
	): Promise<void> {
		const response = await this.client.getStream(locator, {
			timeout: this.config.timeoutMs,
		});
		if (
			response.res.status !== 200 ||
			response.stream === undefined ||
			numericHeader(response.res.headers, "content-length") !==
				expected.sizeBytes ||
			textHeader(response.res.headers, "content-type") !==
				EXPORT_ARTIFACT_CONTENT_TYPE ||
			textHeader(response.res.headers, "x-oss-server-side-encryption") !==
				"AES256"
		) {
			response.stream?.destroy();
			throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
		}
		const md5 = createHash("md5");
		const sha256 = createHash("sha256");
		let totalBytes = 0;
		try {
			for await (const rawChunk of response.stream) {
				const chunk = Buffer.from(rawChunk as Uint8Array);
				try {
					totalBytes += chunk.byteLength;
					if (
						totalBytes > expected.sizeBytes ||
						totalBytes > this.config.maximumArtifactBytes ||
						totalBytes > 10 * 1024 * 1024
					) {
						throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
					}
					md5.update(chunk);
					sha256.update(chunk);
				} finally {
					chunk.fill(0);
				}
			}
			if (
				totalBytes !== expected.sizeBytes ||
				md5.digest("base64") !== expected.contentMd5 ||
				sha256.digest("hex") !== expected.sha256Hex
			) {
				throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
			}
		} finally {
			response.stream.destroy();
		}
	}

	async openArtifact(
		locator: string,
		expected: ExpectedExportArtifact,
	): Promise<OpenedExportArtifact> {
		try {
			assertExportArtifactLocator(locator);
			if (
				expected.contentType !== EXPORT_ARTIFACT_CONTENT_TYPE ||
				!Number.isSafeInteger(expected.sizeBytes) ||
				expected.sizeBytes < 1 ||
				expected.sizeBytes > this.config.maximumArtifactBytes ||
				!SHA256_PATTERN.test(expected.sha256Hex)
			) {
				throw new ExportArtifactStoreError("INVALID_ARTIFACT");
			}
			const response = await this.client.getStream(locator, {
				timeout: this.config.timeoutMs,
			});
			const contentLength = numericHeader(
				response.res.headers,
				"content-length",
			);
			const encryption = textHeader(
				response.res.headers,
				"x-oss-server-side-encryption",
			);
			if (
				response.res.status !== 200 ||
				response.stream === undefined ||
				contentLength !== expected.sizeBytes ||
				textHeader(response.res.headers, "content-type") !==
					expected.contentType ||
				encryption !== "AES256"
			) {
				response.stream?.destroy();
				throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
			}
			return Object.freeze({
				stream: response.stream,
				contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
				sizeBytes: expected.sizeBytes,
			});
		} catch (error) {
			if (error instanceof ExportArtifactStoreError) throw error;
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
	}

	async deleteArtifact(locator: string): Promise<void> {
		try {
			assertExportArtifactLocator(locator);
			if (await this.hasVerifiedTombstone(locator)) return;
			for (
				let attempt = 0;
				attempt < TOMBSTONE_REPLACEMENT_ATTEMPTS;
				attempt += 1
			) {
				const deleted = await this.client.delete(locator, {
					timeout: this.config.timeoutMs,
				});
				if (deleted.res.status !== 204 && deleted.res.status !== 200) {
					throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
				}
				try {
					const placed = await this.client.put(
						locator,
						Buffer.from(TOMBSTONE_BODY),
						{
							timeout: this.config.timeoutMs,
							mime: TOMBSTONE_CONTENT_TYPE,
							headers: {
								"Cache-Control": TOMBSTONE_CACHE_CONTROL,
								"Content-MD5": TOMBSTONE_MD5_BASE64,
								"x-oss-forbid-overwrite": "true",
								"x-oss-object-acl": "private",
								"x-oss-meta-artifact-kind": TOMBSTONE_KIND,
								"x-oss-server-side-encryption": "AES256",
							},
						},
					);
					if (placed.res.status !== 200) {
						throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
					}
				} catch (error) {
					if (!isForbidOverwriteConflict(error)) throw error;
				}
				if (await this.hasVerifiedTombstone(locator)) return;
				// A stale builder won the DELETE -> PUT gap. Remove that personal
				// object on the next bounded attempt and try to occupy the key again.
			}
			throw new ExportArtifactStoreError("INTEGRITY_MISMATCH");
		} catch (error) {
			if (error instanceof ExportArtifactStoreError) throw error;
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
	}

	private async hasVerifiedTombstone(locator: string): Promise<boolean> {
		let response: { readonly res: OssResponse };
		try {
			response = await this.client.head(locator, {
				timeout: this.config.timeoutMs,
			});
		} catch (error) {
			if (isObjectNotFound(error)) return false;
			throw error;
		}
		if (response.res.status === 404) return false;
		if (response.res.status !== 200) {
			throw new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		}
		const headers = response.res.headers;
		const serverContentMd5 = textHeader(headers, "content-md5");
		if (
			numericHeader(headers, "content-length") !== TOMBSTONE_BODY.byteLength ||
			textHeader(headers, "content-type") !== TOMBSTONE_CONTENT_TYPE ||
			textHeader(headers, "cache-control") !== TOMBSTONE_CACHE_CONTROL ||
			textHeader(headers, "x-oss-meta-artifact-kind") !== TOMBSTONE_KIND ||
			textHeader(headers, "x-oss-server-side-encryption") !== "AES256" ||
			(serverContentMd5 !== null && serverContentMd5 !== TOMBSTONE_MD5_BASE64)
		) {
			return false;
		}
		return normalizeMd5Etag(textHeader(headers, "etag")) === TOMBSTONE_MD5_HEX;
	}
}

function usableCredential(
	model: CredentialModel,
): model is Required<Pick<CredentialModel, "accessKeyId" | "accessKeySecret">> &
	CredentialModel {
	return (
		typeof model.accessKeyId === "string" &&
		model.accessKeyId.length > 0 &&
		typeof model.accessKeySecret === "string" &&
		model.accessKeySecret.length > 0 &&
		model.type !== "bearer"
	);
}

export function planExportArtifact(
	exportId: string,
	generatedAt: Date,
): PlannedExportArtifact {
	if (
		!EXPORT_ID_PATTERN.test(exportId) ||
		!Number.isFinite(generatedAt.getTime())
	) {
		throw new ExportArtifactStoreError("INVALID_ARTIFACT");
	}
	const year = generatedAt.getUTCFullYear().toString().padStart(4, "0");
	const month = (generatedAt.getUTCMonth() + 1).toString().padStart(2, "0");
	const locator = `exports/v1/${year}/${month}/${exportId}.json`;
	assertExportArtifactLocator(locator);
	return Object.freeze({
		locator,
		fileName: `chi-shen-me-data-export-${exportId}.json`,
	});
}

function textHeader(headers: object, name: string): string | null {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		return typeof value === "string" ? value : null;
	}
	return null;
}

function numericHeader(headers: object, name: string): number | null {
	const value = textHeader(headers, name);
	if (value === null || !/^(0|[1-9][0-9]{0,9})$/u.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeMd5Etag(value: string | null): string | null {
	if (value === null) return null;
	const normalized =
		value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
	return /^[0-9a-f]{32}$/iu.test(normalized) ? normalized.toLowerCase() : null;
}

function isForbidOverwriteConflict(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as {
		readonly status?: unknown;
		readonly code?: unknown;
	};
	return candidate.status === 409 && candidate.code === "FileAlreadyExists";
}

function isMissingBucketLifecycle(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as {
		readonly status?: unknown;
		readonly code?: unknown;
	};
	return candidate.status === 404 && candidate.code === "NoSuchLifecycle";
}

function isObjectNotFound(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as {
		readonly status?: unknown;
		readonly code?: unknown;
	};
	return (
		candidate.status === 404 &&
		(candidate.code === "NoSuchKey" || candidate.code === "NoSuchObject")
	);
}
