import {
	type AccountExportStatus,
	CONTRACT_VERSION,
	CONTRACT_VERSION_HEADER,
	isUuid,
} from "./contracts";

export interface ExportDownloadRuntime {
	downloadFile(options: {
		url: string;
		header: Record<string, string>;
		timeout: number;
		success(result: {
			statusCode: number;
			tempFilePath: string;
		}): void;
		fail(): void;
	}): unknown;
	getFileSystemManager(): {
		readFile(options: {
			filePath: string;
			success(result: { data: string | ArrayBuffer }): void;
			fail(): void;
		}): void;
		saveFileSync(tempFilePath: string): string;
		unlinkSync(filePath: string): void;
	};
}

export interface ExportDownloadTask {
	abort?(): void;
	onHeadersReceived?(listener: (result: { header: Record<string, unknown> }) => void): void;
}

export interface VerifiedExportDownload {
	readonly savedFilePath: string;
	readonly sizeBytes: number;
	readonly sha256: string;
}

function headerValue(
	headers: Record<string, unknown> | undefined,
	name: string,
): string | null {
	if (headers === undefined) return null;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase())
			return typeof value === "string" ? value : null;
	}
	return null;
}

function rotateRight(value: number, shift: number): number {
	return (value >>> shift) | (value << (32 - shift));
}

const SHA256_CONSTANTS = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(input: ArrayBuffer): string {
	const bytes = new Uint8Array(input);
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const bitLength = bytes.length * 8;
	const view = new DataView(padded.buffer);
	view.setUint32(
		paddedLength - 8,
		Math.floor(bitLength / 0x1_0000_0000),
		false,
	);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);

	const hash = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	]);
	const schedule = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			schedule[index] = view.getUint32(offset + index * 4, false);
		}
		for (let index = 16; index < 64; index += 1) {
			const left = schedule[index - 15] ?? 0;
			const right = schedule[index - 2] ?? 0;
			const sigma0 =
				rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
			const sigma1 =
				rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
			schedule[index] =
				((schedule[index - 16] ?? 0) +
					sigma0 +
					(schedule[index - 7] ?? 0) +
					sigma1) >>>
				0;
		}
		let [a, b, c, d, e, f, g, h] = hash;
		for (let index = 0; index < 64; index += 1) {
			const sigma1 =
				rotateRight(e ?? 0, 6) ^
				rotateRight(e ?? 0, 11) ^
				rotateRight(e ?? 0, 25);
			const choice = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
			const temporary1 =
				((h ?? 0) +
					sigma1 +
					choice +
					(SHA256_CONSTANTS[index] ?? 0) +
					(schedule[index] ?? 0)) >>>
				0;
			const sigma0 =
				rotateRight(a ?? 0, 2) ^
				rotateRight(a ?? 0, 13) ^
				rotateRight(a ?? 0, 22);
			const majority =
				((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
			const temporary2 = (sigma0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = ((d ?? 0) + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}
		const working = [a, b, c, d, e, f, g, h];
		for (let index = 0; index < 8; index += 1) {
			hash[index] = ((hash[index] ?? 0) + (working[index] ?? 0)) >>> 0;
		}
	}
	return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function readFile(
	runtime: ExportDownloadRuntime,
	filePath: string,
): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		runtime.getFileSystemManager().readFile({
			filePath,
			success: (result) =>
				result.data instanceof ArrayBuffer
					? resolve(result.data)
					: reject(new Error("EXPORT_FILE_INVALID")),
			fail: () => reject(new Error("EXPORT_FILE_READ_FAILED")),
		});
	});
}

function saveFile(
	runtime: ExportDownloadRuntime,
	tempFilePath: string,
): string {
	try {
		const savedFilePath = runtime
			.getFileSystemManager()
			.saveFileSync(tempFilePath);
		if (typeof savedFilePath !== "string" || savedFilePath.length === 0) {
			throw new Error("EXPORT_FILE_SAVE_FAILED");
		}
		return savedFilePath;
	} catch {
		throw new Error("EXPORT_FILE_SAVE_FAILED");
	}
}

export class AccountExportDownloader {
	private readonly pending = new Set<() => void>();

	constructor(
		private readonly runtime: ExportDownloadRuntime,
		private readonly baseUrl: string,
		private readonly personalDataAllowed: () => boolean = () => true,
	) {}

	abortAll(): void {
		for (const cancel of [...this.pending]) cancel();
	}

	download(
		status: Extract<AccountExportStatus, { status: "READY" }>,
		accessToken: string,
	): Promise<VerifiedExportDownload> {
		if (!isUuid(status.exportId))
			return Promise.reject(new Error("EXPORT_STATUS_INVALID"));
		if (!this.personalDataAllowed())
			return Promise.reject(new Error("PRIVACY_CONSENT_REQUIRED"));
		return new Promise((resolve, reject) => {
			let settled = false;
			let task: ExportDownloadTask | null = null;
			let responseHeaders: Record<string, unknown> | undefined;
			const finish = (operation: () => void) => {
				if (settled) return;
				settled = true;
				this.pending.delete(cancel);
				operation();
			};
			const cancel = () => {
				if (settled) return;
				finish(() => reject(new Error("PRIVACY_CONSENT_REQUIRED")));
				try {
					task?.abort?.();
				} catch {
					// The local promise is already closed.
				}
			};
			this.pending.add(cancel);
			const options = {
				url: `${this.baseUrl}/v1/account/exports/${status.exportId}/content`,
				header: {
					Accept: "application/json",
					Authorization: `Bearer ${accessToken}`,
					[CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
				},
				timeout: 30_000,
				success: async (response: {
					statusCode: number;
					tempFilePath: string;
				}) => {
					if (settled) {
						this.removeTemporaryFile(response.tempFilePath);
						return;
					}
					try {
						this.requirePersonalDataAllowed();
						if (
							response.statusCode !== 200 ||
							headerValue(responseHeaders, CONTRACT_VERSION_HEADER) !==
								CONTRACT_VERSION ||
							headerValue(responseHeaders, "X-Content-SHA256") !== status.sha256
						) {
							throw new Error("EXPORT_DOWNLOAD_INVALID");
						}
						const content = await readFile(this.runtime, response.tempFilePath);
						if (settled) throw new Error("EXPORT_DOWNLOAD_NOT_ALLOWED");
						this.requirePersonalDataAllowed();
						if (
							content.byteLength !== status.sizeBytes ||
							sha256Hex(content) !== status.sha256
						) {
							throw new Error("EXPORT_DOWNLOAD_INVALID");
						}
						const savedFilePath = saveFile(this.runtime, response.tempFilePath);
						if (!this.personalDataAllowed() || settled) {
							try {
								this.runtime.getFileSystemManager().unlinkSync(savedFilePath);
							} catch {
								throw new Error("EXPORT_FILE_CLEANUP_FAILED");
							}
							throw new Error("PRIVACY_CONSENT_REQUIRED");
						}
						this.removeTemporaryFile(response.tempFilePath);
						finish(() =>
							resolve(
								Object.freeze({
									savedFilePath,
									sizeBytes: content.byteLength,
									sha256: status.sha256,
								}),
							),
						);
					} catch (error) {
						this.removeTemporaryFile(response.tempFilePath);
						finish(() => reject(error));
					}
				},
				fail: () => finish(() => reject(new Error("EXPORT_DOWNLOAD_FAILED"))),
			};
			try {
				const downloadTask = this.runtime.downloadFile(options);
				if (
					typeof downloadTask === "object" &&
					downloadTask !== null &&
					("abort" in downloadTask || "onHeadersReceived" in downloadTask)
				) {
					task = downloadTask as ExportDownloadTask;
					// wx.downloadFile.success does not contain response headers.
					// Read them from the documented DownloadTask event instead.
					task.onHeadersReceived?.((result) => {
						if (!settled) responseHeaders = result.header;
					});
				}
			} catch {
				finish(() => reject(new Error("EXPORT_DOWNLOAD_FAILED")));
			}
		});
	}

	private requirePersonalDataAllowed(): void {
		if (!this.personalDataAllowed()) {
			throw new Error("PRIVACY_CONSENT_REQUIRED");
		}
	}

	private removeTemporaryFile(filePath: string): void {
		try {
			this.runtime.getFileSystemManager().unlinkSync(filePath);
		} catch {
			// Temporary files are platform-managed; deletion is best-effort when the
			// runtime has already moved or reclaimed the path.
		}
	}
}
