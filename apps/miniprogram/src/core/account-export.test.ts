import { describe, expect, it, vi } from "vitest";

import {
	AccountExportDownloader,
	type ExportDownloadRuntime,
	sha256Hex,
} from "./account-export";
import {
	type AccountExportStatus,
	CONTRACT_VERSION,
	CONTRACT_VERSION_HEADER,
} from "./contracts";

const EXPORT_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS_TOKEN = "a".repeat(43);

function completeDownload(
	options: Parameters<ExportDownloadRuntime["downloadFile"]>[0],
	digest: string,
	abort = vi.fn(),
) {
	return {
		abort,
		onHeadersReceived(listener: (result: { header: Record<string, unknown> }) => void) {
			listener({ header: { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION, "X-Content-SHA256": digest } });
			queueMicrotask(() => options.success({ statusCode: 200, tempFilePath: "wxfile://tmp/export.json" }));
		},
	};
}

function bytes(value: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(value);
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
}

function readyStatus(
	content: ArrayBuffer,
): Extract<AccountExportStatus, { status: "READY" }> {
	return {
		exportId: EXPORT_ID,
		status: "READY",
		requestedAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00.000Z",
		includeBehaviorHistory: true,
		readyAt: "2026-01-01T00:01:00.000Z",
		sizeBytes: content.byteLength,
		sha256: sha256Hex(content),
		contentType: "application/json",
		downloadAvailable: true,
	};
}

describe("account export integrity", () => {
	it("matches standard SHA-256 vectors", () => {
		expect(sha256Hex(bytes(""))).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(sha256Hex(bytes("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("saves only a contract-versioned file with matching length and digest", async () => {
		const content = bytes('{"ok":true}');
		const status = readyStatus(content);
		const saveFileSync = vi.fn(() => "wxfile://saved/export.json");
		const downloadFile = vi.fn(
			(options: Parameters<ExportDownloadRuntime["downloadFile"]>[0]) => {
				return completeDownload(options, status.sha256);
			},
		);
		const runtime: ExportDownloadRuntime = {
			downloadFile,
			getFileSystemManager: () => ({
				readFile: (options) => options.success({ data: content }),
				saveFileSync,
				unlinkSync: vi.fn(),
			}),
		};

		const result = await new AccountExportDownloader(
			runtime,
			"https://api.unfinished-era.com",
		).download(status, ACCESS_TOKEN);

		expect(result).toEqual({
			savedFilePath: "wxfile://saved/export.json",
			sizeBytes: content.byteLength,
			sha256: status.sha256,
		});
		expect(downloadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				url: `https://api.unfinished-era.com/v1/account/exports/${EXPORT_ID}/content`,
				header: expect.objectContaining({
					Authorization: `Bearer ${ACCESS_TOKEN}`,
				}),
			}),
		);
		expect(saveFileSync).toHaveBeenCalledWith("wxfile://tmp/export.json");
	});

	it("does not save a file when the response digest header mismatches", async () => {
		const content = bytes('{"ok":true}');
		const status = readyStatus(content);
		const saveFileSync = vi.fn();
		const unlinkSync = vi.fn();
		const runtime: ExportDownloadRuntime = {
			downloadFile(options) {
				return completeDownload(options, "0".repeat(64));
			},
			getFileSystemManager: () => ({
				readFile: (options) => options.success({ data: content }),
				saveFileSync,
				unlinkSync,
			}),
		};

		await expect(
			new AccountExportDownloader(
				runtime,
				"https://api.unfinished-era.com",
			).download(status, ACCESS_TOKEN),
		).rejects.toThrow("EXPORT_DOWNLOAD_INVALID");
		expect(saveFileSync).not.toHaveBeenCalled();
		expect(unlinkSync).toHaveBeenCalledWith("wxfile://tmp/export.json");
	});

	it("aborts an in-flight export download when privacy is withdrawn", async () => {
		const abort = vi.fn();
		const runtime: ExportDownloadRuntime = {
			downloadFile() {
				return { abort };
			},
			getFileSystemManager: () => ({
				readFile: vi.fn(),
				saveFileSync: vi.fn(),
				unlinkSync: vi.fn(),
			}),
		};
		const downloader = new AccountExportDownloader(
			runtime,
			"https://api.unfinished-era.com",
		);
		const pending = downloader.download(readyStatus(bytes("{}")), ACCESS_TOKEN);

		downloader.abortAll();

		await expect(pending).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
		expect(abort).toHaveBeenCalledOnce();
	});

	it("does not save after export capability is revoked during file verification", async () => {
		const content = bytes('{"ok":true}');
		const status = readyStatus(content);
		let completeRead: ((result: { data: ArrayBuffer }) => void) | null = null;
		const saveFileSync = vi.fn(() => "wxfile://saved/export.json");
		const abort = vi.fn();
		const unlinkSync = vi.fn();
		let allowed = true;
		const runtime: ExportDownloadRuntime = {
			downloadFile(options) {
				return completeDownload(options, status.sha256, abort);
			},
			getFileSystemManager: () => ({
				readFile(options) {
					completeRead = options.success as (result: {
						data: ArrayBuffer;
					}) => void;
				},
				saveFileSync,
				unlinkSync,
			}),
		};
		const downloader = new AccountExportDownloader(
			runtime,
			"https://api.unfinished-era.com",
			() => allowed,
		);
		const pending = downloader.download(status, ACCESS_TOKEN);
		await vi.waitFor(() => expect(completeRead).not.toBeNull());
		allowed = false;
		downloader.abortAll();
		if (completeRead === null) throw new Error("READ_NOT_STARTED");
		completeRead({ data: content });

		await expect(pending).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
		await vi.waitFor(() =>
			expect(unlinkSync).toHaveBeenCalledWith("wxfile://tmp/export.json"),
		);
		expect(saveFileSync).not.toHaveBeenCalled();
		expect(abort).toHaveBeenCalledOnce();
	});

	it("removes a temporary file delivered after the request was cancelled", async () => {
		const content = bytes("{}");
		const status = readyStatus(content);
		let deliver:
			| Parameters<ExportDownloadRuntime["downloadFile"]>[0]["success"]
			| null = null;
		const unlinkSync = vi.fn();
		const runtime: ExportDownloadRuntime = {
			downloadFile(options) {
				deliver = options.success;
				return { abort: vi.fn() };
			},
			getFileSystemManager: () => ({
				readFile: vi.fn(),
				saveFileSync: vi.fn(),
				unlinkSync,
			}),
		};
		const downloader = new AccountExportDownloader(
			runtime,
			"https://api.unfinished-era.com",
		);
		const pending = downloader.download(status, ACCESS_TOKEN);
		downloader.abortAll();
		await expect(pending).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
		if (deliver === null) throw new Error("DOWNLOAD_NOT_STARTED");
		deliver({
			statusCode: 200,
			tempFilePath: "wxfile://tmp/late-export.json",
		});

		expect(unlinkSync).toHaveBeenCalledWith("wxfile://tmp/late-export.json");
	});
});
