import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { AccountController } from "./account.controller.js";
import type { AuthService } from "./auth.service.js";

class FakeExportResponse extends Writable {
	readonly headers = new Map<string, string>();
	private idleTimer: NodeJS.Timeout | null = null;

	constructor(private readonly scheduleIdleTimer = true) {
		super();
	}

	setHeader(name: string, value: string): void {
		this.headers.set(name, value);
	}

	setTimeout(milliseconds: number, callback?: () => void): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (milliseconds <= 0) return;
		if (callback !== undefined) this.once("timeout", callback);
		if (this.scheduleIdleTimer) {
			this.idleTimer = setTimeout(() => {
				this.idleTimer = null;
				this.emit("timeout");
			}, milliseconds);
			this.idleTimer.unref();
		}
	}

	override _write(
		_chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		callback();
	}
}

function testConfig(totalTimeoutMs = 120_000, idleTimeoutMs = 15_000) {
	return loadAppConfig({
		NODE_ENV: "test",
		DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS: String(totalTimeoutMs),
		DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("AccountController export delivery", () => {
	it("sets bounded integrity and no-store headers on the authenticated stream", async () => {
		vi.useFakeTimers();
		const sha256 = "00".repeat(32);
		const openExportContent = vi.fn(async () => ({
			body: Readable.from(["{}"]).on("error", () => undefined),
			sizeBytes: 2,
			sha256,
			contentType: "application/json" as const,
		}));
		const controller = new AccountController(
			{ openExportContent } as unknown as AuthService,
			testConfig(),
		);
		const response = new FakeExportResponse();

		const file = await controller.downloadExport(
			{ exportId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f" },
			`Bearer ${"A".repeat(43)}`,
			response,
		);

		expect(file.getStream()).toBeInstanceOf(Readable);
		expect(response.headers).toEqual(
			new Map([
				["Content-Type", "application/json; charset=utf-8"],
				["Content-Length", "2"],
				["Digest", `sha-256=${Buffer.alloc(32).toString("base64")}`],
				["X-Content-SHA256", sha256],
				[
					"Content-Disposition",
					'attachment; filename="chi-shen-me-account-export.json"',
				],
				["Cache-Control", "private, no-store"],
				["Pragma", "no-cache"],
				["Accept-Ranges", "none"],
			]),
		);
		expect(openExportContent).toHaveBeenCalledWith(
			"A".repeat(43),
			"2af305ae-82a1-4f87-86b7-1c97c4a8683f",
		);
		response.emit("finish");
		expect(vi.getTimerCount()).toBe(0);
		expect(file.getStream().destroyed).toBe(true);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(response.destroyed).toBe(false);
	});

	it("destroys a prefetch request at the independent total deadline", async () => {
		vi.useFakeTimers();
		type ExportContent = Awaited<ReturnType<AuthService["openExportContent"]>>;
		let resolvePrefetch!: (content: ExportContent) => void;
		const openExportContent = vi.fn(
			async () =>
				await new Promise<ExportContent>((resolve) => {
					resolvePrefetch = resolve;
				}),
		);
		const controller = new AccountController(
			{ openExportContent } as unknown as AuthService,
			testConfig(),
		);
		// Disable only the fake socket-idle scheduler so this test proves that the
		// controller's independent absolute timer exists.
		const response = new FakeExportResponse(false);
		const result = controller.downloadExport(
			{ exportId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f" },
			`Bearer ${"A".repeat(43)}`,
			response,
		);
		const rejection = expect(result).rejects.toMatchObject({ status: 408 });

		await vi.advanceTimersByTimeAsync(119_999);
		expect(response.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(response.destroyed).toBe(true);
		const lateBody = new Readable({ read() {} });
		resolvePrefetch({
			body: lateBody,
			sizeBytes: 2,
			sha256: "00".repeat(32),
			contentType: "application/json",
		});
		await rejection;
		expect(lateBody.destroyed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("destroys an idle download and leaves no timer handles", async () => {
		vi.useFakeTimers();
		const slowBody = new Readable({ read() {} });
		const controller = new AccountController(
			{
				openExportContent: vi.fn(async () => ({
					body: slowBody,
					sizeBytes: 2,
					sha256: "00".repeat(32),
					contentType: "application/json" as const,
				})),
			} as unknown as AuthService,
			testConfig(),
		);
		const response = new FakeExportResponse();
		const file = await controller.downloadExport(
			{ exportId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f" },
			`Bearer ${"A".repeat(43)}`,
			response,
		);
		file.getStream().pipe(response);

		await vi.advanceTimersByTimeAsync(14_999);
		expect(response.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(response.destroyed).toBe(true);
		expect(slowBody.destroyed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
