import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	AliyunOssExportArtifactStore,
	createAliyunOssExportArtifactStore,
	planExportArtifact,
} from "./aliyun-oss-export-artifact.store.js";
import {
	EXPORT_ARTIFACT_CONTENT_TYPE,
	ExportArtifactStoreError,
} from "./export-artifact.store.js";
import type { ExportArtifactRuntimeConfig } from "./export-artifact-config.js";

const EXPORT_ID = "123e4567-e89b-42d3-a456-426614174000";
const LOCATOR = `exports/v1/2026/08/${EXPORT_ID}.json`;
const TOMBSTONE_TEXT =
	'{"kind":"chi-shen-me-export-tombstone","schemaVersion":1}\n';
const TOMBSTONE_CONTENT_TYPE =
	"application/vnd.chi-shen-me.export-tombstone+json";

function tombstoneHeaders(): Record<string, string> {
	const body = Buffer.from(TOMBSTONE_TEXT, "utf8");
	return {
		etag: `"${createHash("md5").update(body).digest("hex")}"`,
		"content-md5": createHash("md5").update(body).digest("base64"),
		"content-length": body.byteLength.toString(),
		"content-type": TOMBSTONE_CONTENT_TYPE,
		"cache-control": "private, no-store, max-age=0",
		"x-oss-meta-artifact-kind": "chi-shen-me-export-tombstone-v1",
		"x-oss-server-side-encryption": "AES256",
	};
}

function personalObjectHeaders(): Record<string, string> {
	return {
		etag: '"8e5b948a454515dbabfc7eb718daa52f"',
		"content-length": "8",
		"content-type": EXPORT_ARTIFACT_CONTENT_TYPE,
		"cache-control": "private, no-store, max-age=0",
		"x-oss-meta-sha256":
			"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
		"x-oss-server-side-encryption": "AES256",
	};
}

function config(): ExportArtifactRuntimeConfig {
	return Object.freeze({
		enabled: true,
		region: "oss-cn-beijing",
		bucket: "chi-shen-me-private-exports",
		internal: true,
		timeoutMs: 5_000,
		credentialTimeoutMs: 500,
		maximumArtifactBytes: 1024 * 1024,
		ramRoleName: "chi-shen-me-data-export-worker",
		disableImdsV1: true,
		enableImdsV2: true,
		locatorKeyRing: null,
	});
}

describe("AliyunOssExportArtifactStore", () => {
	it("uploads a private SSE object without exposing the SDK URL", async () => {
		const put = vi.fn(async () => ({
			url: "https://must-not-leak.example/signed",
			res: { status: 200, headers: {} },
		}));
		const head = vi.fn(async () => ({
			res: {
				status: 200,
				headers: {
					etag: '"8e5b948a454515dbabfc7eb718daa52f"',
					"content-length": "8",
					"content-type": EXPORT_ARTIFACT_CONTENT_TYPE,
					"cache-control": "private, no-store, max-age=0",
					"content-disposition": `attachment; filename="chi-shen-me-data-export-${EXPORT_ID}.json"`,
					"x-oss-meta-sha256":
						"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
					"x-oss-server-side-encryption": "AES256",
				},
			},
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put,
			head,
			getStream: vi.fn(),
			delete: vi.fn(),
		});
		const plan = planExportArtifact(
			EXPORT_ID,
			new Date("2026-08-21T00:00:00.000Z"),
		);
		const result = await store.putArtifact({
			exportId: EXPORT_ID,
			...plan,
			body: Buffer.from("artifact"),
		});
		expect(result).toEqual({
			locator: `exports/v1/2026/08/${EXPORT_ID}.json`,
			fileName: `chi-shen-me-data-export-${EXPORT_ID}.json`,
			contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
			sizeBytes: 8,
			sha256Hex:
				"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
		});
		const options = put.mock.calls[0]?.[2];
		expect(options?.headers).toMatchObject({
			"Content-MD5": "jluUikVFFdur/H63GNqlLw==",
			"x-oss-forbid-overwrite": "true",
			"x-oss-object-acl": "private",
			"x-oss-meta-sha256":
				"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
			"x-oss-server-side-encryption": "AES256",
			"Cache-Control": "private, no-store, max-age=0",
		});
		expect(JSON.stringify(result)).not.toContain("https://");
		expect(head).toHaveBeenCalledWith(`exports/v1/2026/08/${EXPORT_ID}.json`, {
			timeout: 5_000,
		});
	});

	it("treats an immutable same-content object as an idempotent upload retry", async () => {
		const head = vi.fn(async () => ({
			res: {
				status: 200,
				headers: {
					etag: '"8e5b948a454515dbabfc7eb718daa52f"',
					"content-length": "8",
					"content-type": EXPORT_ARTIFACT_CONTENT_TYPE,
					"cache-control": "private, no-store, max-age=0",
					"content-disposition": `attachment; filename="chi-shen-me-data-export-${EXPORT_ID}.json"`,
					"x-oss-meta-sha256":
						"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
					"x-oss-server-side-encryption": "AES256",
				},
			},
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put: vi.fn(async () => {
				throw { status: 409, code: "FileAlreadyExists" };
			}),
			head,
			getStream: vi.fn(),
			delete: vi.fn(),
		});
		const plan = planExportArtifact(
			EXPORT_ID,
			new Date("2026-08-21T00:00:00.000Z"),
		);
		await expect(
			store.putArtifact({
				exportId: EXPORT_ID,
				...plan,
				body: Buffer.from("artifact"),
			}),
		).resolves.toMatchObject({
			sha256Hex:
				"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
		});
	});

	it("refuses to publish an artifact when the private OSS object cannot be verified", async () => {
		const store = new AliyunOssExportArtifactStore(config(), {
			put: vi.fn(async () => ({ res: { status: 200, headers: {} } })),
			head: vi.fn(async () => ({
				res: {
					status: 200,
					headers: {
						"content-length": "7",
						"content-type": EXPORT_ARTIFACT_CONTENT_TYPE,
						"cache-control": "private, no-store, max-age=0",
						"content-disposition": `attachment; filename="chi-shen-me-data-export-${EXPORT_ID}.json"`,
						"x-oss-meta-sha256":
							"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
						"x-oss-server-side-encryption": "AES256",
					},
				},
			})),
			getStream: vi.fn(),
			delete: vi.fn(),
		});
		const plan = planExportArtifact(
			EXPORT_ID,
			new Date("2026-08-21T00:00:00.000Z"),
		);
		await expect(
			store.putArtifact({
				exportId: EXPORT_ID,
				...plan,
				body: Buffer.from("artifact"),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
	});

	it("recomputes bounded object digests when OSS does not expose a simple MD5 ETag", async () => {
		const metadata = {
			"content-length": "8",
			"content-type": EXPORT_ARTIFACT_CONTENT_TYPE,
			"cache-control": "private, no-store, max-age=0",
			"content-disposition": `attachment; filename="chi-shen-me-data-export-${EXPORT_ID}.json"`,
			"x-oss-meta-sha256":
				"c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
			"x-oss-server-side-encryption": "AES256",
		};
		const getStream = vi.fn(async () => ({
			stream: Readable.from(Buffer.from("tampered")),
			res: { status: 200, headers: metadata },
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put: vi.fn(async () => {
				throw { status: 409, code: "FileAlreadyExists" };
			}),
			head: vi.fn(async () => ({
				res: { status: 200, headers: { ...metadata, etag: '"multipart-2"' } },
			})),
			getStream,
			delete: vi.fn(),
		});
		const plan = planExportArtifact(
			EXPORT_ID,
			new Date("2026-08-21T00:00:00.000Z"),
		);
		await expect(
			store.putArtifact({
				exportId: EXPORT_ID,
				...plan,
				body: Buffer.from("artifact"),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		expect(getStream).toHaveBeenCalledOnce();
	});

	it("replaces an absent object with a fixed verified tombstone", async () => {
		const head = vi
			.fn()
			.mockRejectedValueOnce({ status: 404, code: "NoSuchKey" })
			.mockResolvedValueOnce({
				res: { status: 200, headers: tombstoneHeaders() },
			});
		const put = vi.fn(async () => ({
			res: { status: 200, headers: {} },
		}));
		const remove = vi.fn(async () => ({
			res: { status: 204, headers: {} },
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put,
			head,
			getStream: vi.fn(),
			delete: remove,
		});
		await expect(store.deleteArtifact(LOCATOR)).resolves.toBeUndefined();
		expect(remove).toHaveBeenCalledOnce();
		expect(put).toHaveBeenCalledOnce();
		const [putLocator, putBody, putOptions] = put.mock.calls[0] ?? [];
		expect(putLocator).toBe(LOCATOR);
		expect(Buffer.from(putBody).toString("utf8")).toBe(TOMBSTONE_TEXT);
		expect(Buffer.from(putBody).toString("utf8")).not.toContain(EXPORT_ID);
		expect(putOptions).toMatchObject({
			mime: TOMBSTONE_CONTENT_TYPE,
			headers: {
				"Content-MD5": tombstoneHeaders()["content-md5"],
				"x-oss-forbid-overwrite": "true",
				"x-oss-object-acl": "private",
				"x-oss-server-side-encryption": "AES256",
			},
		});
	});

	it("deletes an existing personal object and permanently occupies its key", async () => {
		const head = vi
			.fn()
			.mockResolvedValueOnce({
				res: { status: 200, headers: personalObjectHeaders() },
			})
			.mockResolvedValueOnce({
				res: { status: 200, headers: tombstoneHeaders() },
			});
		const remove = vi.fn(async () => ({
			res: { status: 204, headers: {} },
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put: vi.fn(async () => ({ res: { status: 200, headers: {} } })),
			head,
			getStream: vi.fn(),
			delete: remove,
		});
		await expect(store.deleteArtifact(LOCATOR)).resolves.toBeUndefined();
		expect(remove).toHaveBeenCalledOnce();
	});

	it("removes a late personal PUT winner and converges to the tombstone", async () => {
		const head = vi
			.fn()
			.mockRejectedValueOnce({ status: 404, code: "NoSuchKey" })
			.mockResolvedValueOnce({
				res: { status: 200, headers: personalObjectHeaders() },
			})
			.mockResolvedValueOnce({
				res: { status: 200, headers: tombstoneHeaders() },
			});
		const put = vi
			.fn()
			.mockRejectedValueOnce({ status: 409, code: "FileAlreadyExists" })
			.mockResolvedValueOnce({ res: { status: 200, headers: {} } });
		const remove = vi.fn(async () => ({
			res: { status: 204, headers: {} },
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put,
			head,
			getStream: vi.fn(),
			delete: remove,
		});
		await expect(store.deleteArtifact(LOCATOR)).resolves.toBeUndefined();
		expect(remove).toHaveBeenCalledTimes(2);
		expect(put).toHaveBeenCalledTimes(2);
	});

	it("makes a tombstone-first winner permanent and rejects a stale personal PUT", async () => {
		const head = vi
			.fn()
			.mockRejectedValueOnce({ status: 404, code: "NoSuchKey" })
			.mockResolvedValue({
				res: { status: 200, headers: tombstoneHeaders() },
			});
		const put = vi
			.fn()
			.mockResolvedValueOnce({ res: { status: 200, headers: {} } })
			.mockRejectedValueOnce({ status: 409, code: "FileAlreadyExists" });
		const remove = vi.fn(async () => ({
			res: { status: 204, headers: {} },
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put,
			head,
			getStream: vi.fn(),
			delete: remove,
		});
		await expect(store.deleteArtifact(LOCATOR)).resolves.toBeUndefined();
		await expect(
			store.putArtifact({
				exportId: EXPORT_ID,
				locator: LOCATOR,
				fileName: `chi-shen-me-data-export-${EXPORT_ID}.json`,
				body: Buffer.from("artifact"),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		expect(remove).toHaveBeenCalledOnce();
	});

	it("does not delete or rewrite an already verified permanent tombstone", async () => {
		const remove = vi.fn();
		const put = vi.fn();
		const store = new AliyunOssExportArtifactStore(config(), {
			put,
			head: vi.fn(async () => ({
				res: { status: 200, headers: tombstoneHeaders() },
			})),
			getStream: vi.fn(),
			delete: remove,
		});
		await expect(store.deleteArtifact(LOCATOR)).resolves.toBeUndefined();
		expect(remove).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it("fails closed on an unknown 409 without deleting in a retry loop", async () => {
		const put = vi.fn(async () => {
			throw { status: 409, code: "Conflict" };
		});
		const remove = vi.fn(async () => ({
			res: { status: 204, headers: {} },
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put,
			head: vi.fn(async () => ({ res: { status: 404, headers: {} } })),
			getStream: vi.fn(),
			delete: remove,
		});
		await expect(store.deleteArtifact(LOCATOR)).rejects.toMatchObject({
			failure: "UPSTREAM_UNAVAILABLE",
		});
		expect(remove).toHaveBeenCalledOnce();
		expect(put).toHaveBeenCalledOnce();
	});

	it("bounds repeated stale PUT races to five replacement attempts", async () => {
		const put = vi.fn(async () => {
			throw { status: 409, code: "FileAlreadyExists" };
		});
		const remove = vi.fn(async () => ({
			res: { status: 204, headers: {} },
		}));
		const head = vi
			.fn()
			.mockRejectedValueOnce({ status: 404, code: "NoSuchKey" })
			.mockResolvedValue({
				res: { status: 200, headers: personalObjectHeaders() },
			});
		const store = new AliyunOssExportArtifactStore(config(), {
			put,
			head,
			getStream: vi.fn(),
			delete: remove,
		});
		await expect(store.deleteArtifact(LOCATOR)).rejects.toMatchObject({
			failure: "INTEGRITY_MISMATCH",
		});
		expect(remove).toHaveBeenCalledTimes(5);
		expect(put).toHaveBeenCalledTimes(5);
	});

	it("opens only a size-matched SSE stream and destroys a mismatched stream", async () => {
		const validStream = Readable.from(Buffer.from("artifact"));
		const getStream = vi.fn(async () => ({
			stream: validStream,
			res: {
				status: 200,
				headers: {
					"content-length": "8",
					"content-type": EXPORT_ARTIFACT_CONTENT_TYPE,
					"x-oss-server-side-encryption": "AES256",
				},
			},
		}));
		const store = new AliyunOssExportArtifactStore(config(), {
			put: vi.fn(),
			head: vi.fn(),
			getStream,
			delete: vi.fn(),
		});
		const locator = `exports/v1/2026/08/${EXPORT_ID}.json`;
		const opened = await store.openArtifact(locator, {
			contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
			sizeBytes: 8,
			sha256Hex: "a".repeat(64),
		});
		expect(opened.stream).toBe(validStream);

		const badStream = Readable.from(Buffer.from("short"));
		const destroy = vi.spyOn(badStream, "destroy");
		getStream.mockResolvedValueOnce({
			stream: badStream,
			res: {
				status: 200,
				headers: {
					"content-length": "5",
					"content-type": EXPORT_ARTIFACT_CONTENT_TYPE,
					"x-oss-server-side-encryption": "AES256",
				},
			},
		});
		await expect(
			store.openArtifact(locator, {
				contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
				sizeBytes: 8,
				sha256Hex: "a".repeat(64),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		expect(destroy).toHaveBeenCalled();
	});

	it("preflights the official credential chain and sanitizes every failure", async () => {
		await expect(
			createAliyunOssExportArtifactStore(config(), {
				createCredential: () => ({
					getCredential: async () => {
						throw new Error("secret/profile/path");
					},
				}),
				createClient: vi.fn(),
			}),
		).rejects.toEqual(
			expect.objectContaining({
				name: "ExportArtifactStoreError",
				message: "数据导出工件存储暂不可用",
				failure: "CREDENTIAL_UNAVAILABLE",
			}),
		);

		const error = new ExportArtifactStoreError("UPSTREAM_UNAVAILABLE");
		expect(JSON.stringify(error)).not.toMatch(/secret|profile|url/iu);
	});

	it("accepts only absent, null or empty OSS versioning status during startup readiness", async () => {
		const credential = {
			getCredential: async () => ({
				accessKeyId: "temporary-id",
				accessKeySecret: "temporary-secret",
				securityToken: "temporary-token",
				type: "ecs_ram_role",
			}),
		};
		const createClient = (
			versionStatus?: string | null,
			responseStatus = 200,
		) => ({
			getBucketVersioning: vi.fn(async () => ({
				status: responseStatus,
				versionStatus,
				res: { status: responseStatus, headers: {} },
			})),
			getBucketLifecycle: vi.fn(async () => {
				throw { status: 404, code: "NoSuchLifecycle" };
			}),
			put: vi.fn(),
			head: vi.fn(),
			getStream: vi.fn(),
			delete: vi.fn(),
		});
		for (const status of [undefined, null, ""] as const) {
			await expect(
				createAliyunOssExportArtifactStore(config(), {
					createCredential: () => credential,
					createClient: () => createClient(status),
				}),
			).resolves.toBeInstanceOf(AliyunOssExportArtifactStore);
		}
		for (const status of [
			"Enabled",
			"Suspended",
			"Disabled",
			"Unknown",
		] as const) {
			await expect(
				createAliyunOssExportArtifactStore(config(), {
					createCredential: () => credential,
					createClient: () => createClient(status),
				}),
			).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		}
		await expect(
			createAliyunOssExportArtifactStore(config(), {
				createCredential: () => credential,
				createClient: () => createClient(undefined, 403),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		await expect(
			createAliyunOssExportArtifactStore(config(), {
				createCredential: () => credential,
				createClient: () => ({
					...createClient(),
					getBucketVersioning: vi.fn(async () => {
						throw new Error("timeout or XML parse failure");
					}),
				}),
			}),
		).rejects.toMatchObject({ failure: "UPSTREAM_UNAVAILABLE" });
	});

	it("requires a bucket with no lifecycle rules so deletion tombstones remain permanent", async () => {
		const credential = {
			getCredential: async () => ({
				accessKeyId: "temporary-id",
				accessKeySecret: "temporary-secret",
				securityToken: "temporary-token",
				type: "ecs_ram_role",
			}),
		};
		const createClient = (
			getBucketLifecycle: () => Promise<{
				readonly rules?: readonly unknown[] | null;
				readonly res: { readonly status: number; readonly headers: object };
			}>,
		) => ({
			getBucketVersioning: vi.fn(async () => ({
				status: 200,
				versionStatus: undefined,
				res: { status: 200, headers: {} },
			})),
			getBucketLifecycle,
			put: vi.fn(),
			head: vi.fn(),
			getStream: vi.fn(),
			delete: vi.fn(),
		});
		for (const rules of [null, undefined, []] as const) {
			await expect(
				createAliyunOssExportArtifactStore(config(), {
					createCredential: () => credential,
					createClient: () =>
						createClient(async () => ({
							rules,
							res: { status: 200, headers: {} },
						})),
				}),
			).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		}
		await expect(
			createAliyunOssExportArtifactStore(config(), {
				createCredential: () => credential,
				createClient: () =>
					createClient(async () => {
						throw { status: 404, code: "NoSuchLifecycle" };
					}),
			}),
		).resolves.toBeInstanceOf(AliyunOssExportArtifactStore);

		for (const rules of [
			[{ id: "expire-exports", status: "Enabled" }],
			[{ id: "disabled-rule", status: "Disabled" }],
		] as const) {
			await expect(
				createAliyunOssExportArtifactStore(config(), {
					createCredential: () => credential,
					createClient: () =>
						createClient(async () => ({
							rules,
							res: { status: 200, headers: {} },
						})),
				}),
			).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		}
		for (const lifecycleFailure of [
			{ status: 403, code: "AccessDenied" },
			{ status: 404, code: "NoSuchKey" },
			new Error("timeout or malformed XML"),
		]) {
			await expect(
				createAliyunOssExportArtifactStore(config(), {
					createCredential: () => credential,
					createClient: () =>
						createClient(async () => {
							throw lifecycleFailure;
						}),
				}),
			).rejects.toMatchObject({ failure: "UPSTREAM_UNAVAILABLE" });
		}
		await expect(
			createAliyunOssExportArtifactStore(config(), {
				createCredential: () => credential,
				createClient: () =>
					createClient(async () => ({
						rules: { status: "Enabled" } as unknown as readonly unknown[],
						res: { status: 200, headers: {} },
					})),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
	});
});
