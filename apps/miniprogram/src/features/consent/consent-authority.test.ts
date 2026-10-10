import { describe, expect, it, vi } from "vitest";
import {
	PRIVACY_POLICY_VERSION,
	PrivacyConsentAuthority,
	TERMS_VERSION,
} from "./consent-authority";

class MemoryStorage {
	readonly values = new Map<string, unknown>();

	getStorageSync(key: string): unknown {
		return this.values.get(key);
	}

	setStorageSync(key: string, value: unknown): void {
		this.values.set(key, value);
	}

	removeStorageSync(key: string): void {
		this.values.delete(key);
	}
}

class WithdrawalFallbackStorage extends MemoryStorage {
	failPrimaryWithdrawalWrites = false;

	override setStorageSync(key: string, value: unknown): void {
		if (
			this.failPrimaryWithdrawalWrites &&
			key === "chi-shen-me.privacy-withdrawal.v1"
		) {
			throw new Error("WITHDRAWAL_MARKER_WRITE_FAILED");
		}
		super.setStorageSync(key, value);
	}

	override removeStorageSync(key: string): void {
		if (
			this.failPrimaryWithdrawalWrites &&
			key === "chi-shen-me.privacy-consent.v1"
		) {
			throw new Error("CONSENT_REMOVE_FAILED");
		}
		super.removeStorageSync(key);
	}
}

class MarkerWriteFailureStorage extends MemoryStorage {
	override setStorageSync(key: string, value: unknown): void {
		if (key === "chi-shen-me.privacy-withdrawal.v1") {
			throw new Error("WITHDRAWAL_MARKER_WRITE_FAILED");
		}
		super.setStorageSync(key, value);
	}
}

class ConsentRemovalFailureStorage extends MemoryStorage {
	failConsentRemoval = false;

	override removeStorageSync(key: string): void {
		if (this.failConsentRemoval && key === "chi-shen-me.privacy-consent.v1") {
			throw new Error("CONSENT_REMOVE_FAILED");
		}
		super.removeStorageSync(key);
	}
}

describe("PrivacyConsentAuthority", () => {
	it("fails closed before current document versions are accepted", () => {
		const storage = new MemoryStorage();
		storage.values.set("chi-shen-me.privacy-consent.v1", {
			version: 1,
			privacyPolicyVersion: `${PRIVACY_POLICY_VERSION}-old`,
			termsVersion: TERMS_VERSION,
			acceptedAt: "2026-08-30T00:00:00.000Z",
		});
		expect(new PrivacyConsentAuthority(storage).isAllowed()).toBe(false);
	});

	it("opens only after a verified durable consent write", () => {
		const storage = new MemoryStorage();
		const authority = new PrivacyConsentAuthority(storage);
		expect(authority.accept(new Date("2026-08-30T00:00:00.000Z"))).toBe(true);
		expect(authority.isAllowed()).toBe(true);
		expect(new PrivacyConsentAuthority(storage).isAllowed()).toBe(true);
	});

	it("closes before clearing sensitive local state and persists withdrawal", () => {
		const storage = new MemoryStorage();
		const authority = new PrivacyConsentAuthority(storage);
		authority.accept(new Date("2026-08-30T00:00:00.000Z"));
		const clear = vi.fn(() => expect(authority.isAllowed()).toBe(false));
		expect(authority.withdraw(clear)).toBe(true);
		expect(clear).toHaveBeenCalledOnce();
		expect(new PrivacyConsentAuthority(storage).isAllowed()).toBe(false);
	});

	it("stays closed and reports incomplete cleanup without propagating errors", () => {
		const storage = new MemoryStorage();
		const authority = new PrivacyConsentAuthority(storage);
		authority.accept(new Date("2026-08-30T00:00:00.000Z"));

		expect(
			authority.withdraw(() => {
				throw new Error("STORAGE_CLEAR_FAILED");
			}),
		).toBe(false);
		expect(authority.isAllowed()).toBe(false);
		expect(new PrivacyConsentAuthority(storage).isAllowed()).toBe(false);
	});

	it("writes an invalid consent tombstone when primary withdrawal storage operations fail", () => {
		const storage = new WithdrawalFallbackStorage();
		const authority = new PrivacyConsentAuthority(storage);
		authority.accept(new Date("2026-08-30T00:00:00.000Z"));
		storage.failPrimaryWithdrawalWrites = true;

		expect(authority.withdraw(() => undefined)).toBe(true);
		expect(new PrivacyConsentAuthority(storage).isAllowed()).toBe(false);
		expect(storage.values.get("chi-shen-me.privacy-consent.v1")).toEqual({
			version: 0,
			withdrawn: true,
		});
	});

	it("does not accept again until pending sensitive cleanup succeeds", () => {
		const storage = new MemoryStorage();
		const authority = new PrivacyConsentAuthority(storage);
		authority.accept(new Date("2026-08-30T00:00:00.000Z"));
		authority.withdraw(() => {
			throw new Error("SESSION_CLEAR_FAILED");
		});

		expect(authority.accept(new Date("2026-08-30T01:00:00.000Z"))).toBe(false);
		const retryCleanup = vi.fn();
		expect(
			authority.accept(new Date("2026-08-30T01:00:00.000Z"), retryCleanup),
		).toBe(true);
		expect(retryCleanup).toHaveBeenCalledOnce();
		expect(authority.isAllowed()).toBe(true);
	});

	it("persists a consent tombstone when marker creation and cleanup both fail", () => {
		const storage = new MarkerWriteFailureStorage();
		const authority = new PrivacyConsentAuthority(storage);
		authority.accept(new Date("2026-08-30T00:00:00.000Z"));

		expect(
			authority.withdraw(() => {
				throw new Error("SESSION_CLEAR_FAILED");
			}),
		).toBe(false);
		expect(storage.values.get("chi-shen-me.privacy-consent.v1")).toEqual({
			version: 0,
			withdrawn: true,
		});
		expect(new PrivacyConsentAuthority(storage).isAllowed()).toBe(false);
	});

	it("keeps the withdrawal marker until old consent invalidation succeeds", () => {
		const storage = new ConsentRemovalFailureStorage();
		const initial = new PrivacyConsentAuthority(storage);
		initial.accept(new Date("2026-08-30T00:00:00.000Z"));
		storage.values.set("chi-shen-me.privacy-withdrawal.v1", {
			version: 1,
			withdrawnAt: "2026-08-30T00:30:00.000Z",
		});
		storage.failConsentRemoval = true;
		const authority = new PrivacyConsentAuthority(storage);

		expect(
			authority.accept(new Date("2026-08-30T01:00:00.000Z"), vi.fn()),
		).toBe(false);
		expect(storage.values.has("chi-shen-me.privacy-withdrawal.v1")).toBe(true);
		expect(new PrivacyConsentAuthority(storage).isAllowed()).toBe(false);
	});
});
