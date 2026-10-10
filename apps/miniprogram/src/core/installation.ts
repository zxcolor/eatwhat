import { isUuid } from "./contracts";
import type { StoragePort } from "./session-store";

const INSTALLATION_STORAGE_KEY = "chi-shen-me.installation.v1";

export interface SecureRandomPort {
	getRandomValues(options: {
		length: number;
		success(result: { randomValues: ArrayBuffer }): void;
		fail(): void;
	}): void;
}

function bytesToUuid(bytes: Uint8Array): string {
	if (bytes.byteLength !== 16) throw new Error("SECURE_RANDOM_INVALID");
	const normalized = new Uint8Array(bytes);
	normalized[6] = ((normalized[6] ?? 0) & 0x0f) | 0x40;
	normalized[8] = ((normalized[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...normalized].map((value) =>
		value.toString(16).padStart(2, "0"),
	);
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
		.slice(6, 8)
		.join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function createRandomUuid(runtime: SecureRandomPort): Promise<string> {
	return new Promise((resolve, reject) => {
		runtime.getRandomValues({
			length: 16,
			success: (result) => {
				try {
					const uuid = bytesToUuid(new Uint8Array(result.randomValues));
					if (!isUuid(uuid)) throw new Error("SECURE_RANDOM_INVALID");
					resolve(uuid);
				} catch {
					reject(new Error("SECURE_RANDOM_INVALID"));
				}
			},
			fail: () => reject(new Error("SECURE_RANDOM_UNAVAILABLE")),
		});
	});
}

export class InstallationStore {
	constructor(
		private readonly storage: StoragePort,
		private readonly random: SecureRandomPort,
		private readonly personalDataAllowed: () => boolean = () => true,
	) {}

	async getOrCreate(): Promise<string> {
		if (!this.personalDataAllowed()) {
			throw new Error("PRIVACY_CONSENT_REQUIRED");
		}
		const stored = this.storage.getStorageSync(INSTALLATION_STORAGE_KEY);
		if (isUuid(stored)) return stored;
		if (stored !== undefined && stored !== null && stored !== "") {
			this.storage.removeStorageSync(INSTALLATION_STORAGE_KEY);
		}
		const installationId = await createRandomUuid(this.random);
		if (!this.personalDataAllowed()) {
			throw new Error("PRIVACY_CONSENT_REQUIRED");
		}
		this.storage.setStorageSync(INSTALLATION_STORAGE_KEY, installationId);
		return installationId;
	}

	clear(): void {
		this.storage.removeStorageSync(INSTALLATION_STORAGE_KEY);
	}
}
