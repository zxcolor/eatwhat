import { createHash, randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { StreamableFile } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
	EXPORT_ARTIFACT_CONTENT_TYPE,
	type ExportArtifactStore,
} from "./export-artifact.store.js";
import type { ExportArtifactRuntimeConfig } from "./export-artifact-config.js";
import {
	ExportLocatorKeyRing,
	encryptExportArtifactLocator,
} from "./export-artifact-crypto.js";
import { PrivateExportArtifactReader } from "./private-export-artifact.reader.js";

const EXPORT_ID = "123e4567-e89b-42d3-a456-426614174000";

function setup(
	body: Buffer,
	maximumArtifactBytes = 1024,
): {
	readonly reader: PrivateExportArtifactReader;
	readonly ring: ExportLocatorKeyRing;
	readonly encrypted: ReturnType<typeof encryptExportArtifactLocator>;
	readonly openArtifact: ReturnType<typeof vi.fn>;
} {
	const ring = new ExportLocatorKeyRing(
		"locator-v1",
		new Map([["locator-v1", randomBytes(32)]]),
	);
	const config: ExportArtifactRuntimeConfig = Object.freeze({
		enabled: true,
		region: "oss-cn-beijing",
		bucket: "chi-shen-me-private-exports",
		internal: true,
		timeoutMs: 5_000,
		credentialTimeoutMs: 500,
		maximumArtifactBytes,
		ramRoleName: "chi-shen-me-data-export-worker",
		disableImdsV1: true,
		enableImdsV2: true,
		locatorKeyRing: ring,
	});
	const openArtifact = vi.fn(async () => ({
		stream: Readable.from(body),
		contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
		sizeBytes: body.byteLength,
	}));
	const store = {
		putArtifact: vi.fn(),
		openArtifact,
		deleteArtifact: vi.fn(),
	} as unknown as ExportArtifactStore;
	return {
		reader: new PrivateExportArtifactReader(config, store),
		ring,
		encrypted: encryptExportArtifactLocator(
			`exports/v1/2026/08/${EXPORT_ID}.json`,
			ring,
		),
		openArtifact,
	};
}

async function readAll(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

describe("PrivateExportArtifactReader", () => {
	it("decrypts the internal locator and verifies the streamed digest", async () => {
		const body = Buffer.from('{"schemaVersion":1}', "utf8");
		const state = setup(body);
		const digest = createHash("sha256").update(body).digest("hex");
		const opened = await state.reader.open({
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: digest,
		});
		expect((await readAll(opened.body)).equals(body)).toBe(true);
		expect(state.openArtifact).toHaveBeenCalledWith(
			`exports/v1/2026/08/${EXPORT_ID}.json`,
			{
				contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
				sizeBytes: body.byteLength,
				sha256Hex: digest,
			},
		);
		state.ring.destroy();
	});

	it("rejects before returning a response stream when object bytes do not match", async () => {
		const body = Buffer.from("tampered", "utf8");
		const state = setup(body);
		await expect(
			state.reader.open({
				locatorCiphertext: state.encrypted.ciphertext,
				locatorKeyVersion: state.encrypted.keyVersion,
				expectedSizeBytes: body.byteLength,
				expectedSha256: "a".repeat(64),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		state.ring.destroy();
	});

	it("rejects a short object before exposing any body", async () => {
		const body = Buffer.from("short", "utf8");
		const state = setup(body);
		await expect(
			state.reader.open({
				locatorCiphertext: state.encrypted.ciphertext,
				locatorKeyVersion: state.encrypted.keyVersion,
				expectedSizeBytes: body.byteLength + 1,
				expectedSha256: createHash("sha256").update(body).digest("hex"),
			}),
		).rejects.toMatchObject({ failure: "INTEGRITY_MISMATCH" });
		state.ring.destroy();
	});

	it("rejects metadata or mid-stream failures before returning any readable body", async () => {
		const body = Buffer.from("artifact", "utf8");
		const state = setup(body);
		const request = {
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: createHash("sha256").update(body).digest("hex"),
		};
		state.openArtifact.mockResolvedValueOnce({
			stream: Readable.from(body),
			contentType: "text/plain",
			sizeBytes: body.byteLength,
		});
		await expect(state.reader.open(request)).rejects.toMatchObject({
			failure: "INTEGRITY_MISMATCH",
		});

		const failed = new Readable({
			read() {
				this.push(body.subarray(0, 2));
				this.destroy(new Error("upstream failed after bytes"));
			},
		});
		state.openArtifact.mockResolvedValueOnce({
			stream: failed,
			contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
			sizeBytes: body.byteLength,
		});
		await expect(state.reader.open(request)).rejects.toMatchObject({
			failure: "UPSTREAM_UNAVAILABLE",
		});
		state.ring.destroy();
	});

	it("rejects oversized or malformed expectations before OSS access", async () => {
		const state = setup(Buffer.from("body"));
		await expect(
			state.reader.open({
				locatorCiphertext: state.encrypted.ciphertext,
				locatorKeyVersion: state.encrypted.keyVersion,
				expectedSizeBytes: 1025,
				expectedSha256: "not-a-digest",
			}),
		).rejects.toMatchObject({ failure: "INVALID_ARTIFACT" });
		expect(state.openArtifact).not.toHaveBeenCalled();
		state.ring.destroy();
	});

	it("enforces the absolute 10 MiB reader ceiling even with an unsafe injected config", async () => {
		const state = setup(Buffer.from("body"), 20 * 1024 * 1024);
		await expect(
			state.reader.open({
				locatorCiphertext: state.encrypted.ciphertext,
				locatorKeyVersion: state.encrypted.keyVersion,
				expectedSizeBytes: 10 * 1024 * 1024 + 1,
				expectedSha256: "a".repeat(64),
			}),
		).rejects.toMatchObject({ failure: "INVALID_ARTIFACT" });
		expect(state.openArtifact).not.toHaveBeenCalled();
		state.ring.destroy();
	});

	it("holds four verified downloads and rejects the fifth before OSS access", async () => {
		const body = Buffer.from("bounded-artifact", "utf8");
		const state = setup(body);
		const digest = createHash("sha256").update(body).digest("hex");
		const request = {
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: digest,
		};
		const opened = await Promise.all(
			Array.from({ length: 4 }, () => state.reader.open(request)),
		);

		await expect(state.reader.open(request)).rejects.toMatchObject({
			failure: "UPSTREAM_UNAVAILABLE",
		});
		expect(state.openArtifact).toHaveBeenCalledTimes(4);

		for (const item of opened) item.body.destroy();
		state.ring.destroy();
	});

	it("releases a held slot when the returned response body is destroyed", async () => {
		const body = Buffer.from("destroy-release", "utf8");
		const state = setup(body);
		const request = {
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: createHash("sha256").update(body).digest("hex"),
		};
		const opened = await Promise.all(
			Array.from({ length: 4 }, () => state.reader.open(request)),
		);

		opened[0]?.body.destroy();
		const replacement = await state.reader.open(request);
		expect(state.openArtifact).toHaveBeenCalledTimes(5);

		replacement.body.destroy();
		for (const item of opened.slice(1)) item.body.destroy();
		state.ring.destroy();
	});

	it("keeps bytes and the slot until a StreamableFile destination finishes", async () => {
		const body = Buffer.from("delayed-transport", "utf8");
		const state = setup(body);
		const request = {
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: createHash("sha256").update(body).digest("hex"),
		};
		const held = await Promise.all(
			Array.from({ length: 3 }, () => state.reader.open(request)),
		);
		const transported = await state.reader.open(request);
		let finishWrite = () => undefined;
		let queuedChunk: Buffer | null = null;
		const writeStarted = new Promise<void>((resolve) => {
			finishWrite = resolve;
		});
		let allowWriteToFinish = () => undefined;
		const destination = new Writable({
			highWaterMark: 1024,
			write(chunk: Buffer, _encoding, callback) {
				queuedChunk = chunk;
				allowWriteToFinish = () => callback();
				finishWrite();
			},
		});
		const sourceEnded = new Promise<void>((resolve, reject) => {
			transported.body.once("end", resolve);
			transported.body.once("error", reject);
		});
		const destinationFinished = new Promise<void>((resolve, reject) => {
			destination.once("finish", resolve);
			destination.once("error", reject);
		});

		const streamableFile = new StreamableFile(transported.body);
		expect(streamableFile.getStream()).toBe(transported.body);
		streamableFile.getStream().pipe(destination);
		await writeStarted;
		await sourceEnded;
		expect(destination.writableFinished).toBe(false);
		expect(queuedChunk?.equals(body)).toBe(true);
		await expect(state.reader.open(request)).rejects.toMatchObject({
			failure: "UPSTREAM_UNAVAILABLE",
		});
		expect(state.openArtifact).toHaveBeenCalledTimes(4);

		allowWriteToFinish();
		await destinationFinished;
		expect(queuedChunk?.every((byte) => byte === 0)).toBe(true);
		const replacement = await state.reader.open(request);
		replacement.body.destroy();
		for (const item of held) item.body.destroy();
		state.ring.destroy();
	});

	it("clears the buffer and releases the slot when the destination is already closed", async () => {
		const body = Buffer.from("preclosed-destination", "utf8");
		const state = setup(body);
		const request = {
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: createHash("sha256").update(body).digest("hex"),
		};
		const opened = await Promise.all(
			Array.from({ length: 4 }, () => state.reader.open(request)),
		);
		const rejectedBody = opened[0]?.body;
		expect(rejectedBody).toBeDefined();
		const verifiedBuffer = Reflect.get(
			rejectedBody as Readable,
			"verifiedBody",
		) as Buffer;
		expect(verifiedBuffer.equals(body)).toBe(true);
		let destinationWriteCalled = false;
		const destination = new Writable({
			write(_chunk, _encoding, callback) {
				destinationWriteCalled = true;
				callback();
			},
		});
		await new Promise<void>((resolve) => {
			destination.once("close", resolve);
			destination.destroy();
		});

		let pipeFailure: unknown = null;
		try {
			new StreamableFile(rejectedBody as Readable)
				.getStream()
				.pipe(destination);
		} catch (error) {
			pipeFailure = error;
		}
		expect(pipeFailure).toMatchObject({ failure: "UPSTREAM_UNAVAILABLE" });
		expect(destinationWriteCalled).toBe(false);
		expect(verifiedBuffer.every((byte) => byte === 0)).toBe(true);

		const replacement = await state.reader.open(request);
		expect(state.openArtifact).toHaveBeenCalledTimes(5);
		replacement.body.destroy();
		for (const item of opened.slice(1)) item.body.destroy();
		state.ring.destroy();
	});

	it("does not leak a slot when the client aborts during OSS prefetch", async () => {
		const body = Buffer.from("abort-during-prefetch", "utf8");
		const state = setup(body);
		const request = {
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: createHash("sha256").update(body).digest("hex"),
		};
		const upstream = new Readable({ read() {} });
		state.openArtifact.mockResolvedValueOnce({
			stream: upstream,
			contentType: EXPORT_ARTIFACT_CONTENT_TYPE,
			sizeBytes: body.byteLength,
		});
		const opening = state.reader.open(request);
		await vi.waitFor(() => expect(state.openArtifact).toHaveBeenCalledTimes(1));
		let destinationWriteCalled = false;
		const destination = new Writable({
			write(_chunk, _encoding, callback) {
				destinationWriteCalled = true;
				callback();
			},
		});
		await new Promise<void>((resolve) => {
			destination.once("close", resolve);
			destination.destroy();
		});
		upstream.push(body);
		upstream.push(null);
		const opened = await opening;
		const verifiedBuffer = Reflect.get(opened.body, "verifiedBody") as Buffer;

		let pipeFailure: unknown = null;
		try {
			new StreamableFile(opened.body).getStream().pipe(destination);
		} catch (error) {
			pipeFailure = error;
		}
		expect(pipeFailure).toMatchObject({ failure: "UPSTREAM_UNAVAILABLE" });
		expect(destinationWriteCalled).toBe(false);
		expect(verifiedBuffer.every((byte) => byte === 0)).toBe(true);

		const replacements = await Promise.all(
			Array.from({ length: 4 }, () => state.reader.open(request)),
		);
		expect(state.openArtifact).toHaveBeenCalledTimes(5);
		for (const replacement of replacements) replacement.body.destroy();
		state.ring.destroy();
	});

	it("releases its slot after an OSS exception", async () => {
		const body = Buffer.from("failure-release", "utf8");
		const state = setup(body);
		const request = {
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: createHash("sha256").update(body).digest("hex"),
		};
		state.openArtifact.mockRejectedValueOnce(new Error("OSS unavailable"));

		await expect(state.reader.open(request)).rejects.toMatchObject({
			failure: "UPSTREAM_UNAVAILABLE",
		});
		const opened = await Promise.all(
			Array.from({ length: 4 }, () => state.reader.open(request)),
		);
		await expect(state.reader.open(request)).rejects.toMatchObject({
			failure: "UPSTREAM_UNAVAILABLE",
		});
		expect(state.openArtifact).toHaveBeenCalledTimes(5);

		for (const item of opened) item.body.destroy();
		state.ring.destroy();
	});

	it("emits the verified buffer once and zeroes that buffer after consumption", async () => {
		const body = Buffer.from("single-buffer", "utf8");
		const state = setup(body);
		const opened = await state.reader.open({
			locatorCiphertext: state.encrypted.ciphertext,
			locatorKeyVersion: state.encrypted.keyVersion,
			expectedSizeBytes: body.byteLength,
			expectedSha256: createHash("sha256").update(body).digest("hex"),
		});
		let emitted: Buffer | null = null;
		let received: Buffer | null = null;
		opened.body.on("data", (chunk: Buffer) => {
			emitted = chunk;
			received = Buffer.from(chunk);
		});
		await new Promise<void>((resolve, reject) => {
			opened.body.once("end", resolve);
			opened.body.once("error", reject);
		});

		expect(received?.equals(body)).toBe(true);
		expect(emitted?.every((byte) => byte === 0)).toBe(true);
		state.ring.destroy();
	});
});
