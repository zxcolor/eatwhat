export const PRIVACY_POLICY_VERSION = "privacy-alpha-2026-08-20.1";
export const TERMS_VERSION = "terms-alpha-2026-08-20.1";

const CONSENT_STORAGE_KEY = "chi-shen-me.privacy-consent.v1";
const WITHDRAWAL_STORAGE_KEY = "chi-shen-me.privacy-withdrawal.v1";

interface ConsentStorage {
	getStorageSync(key: string): unknown;
	setStorageSync(key: string, value: unknown): void;
	removeStorageSync(key: string): void;
}

interface ConsentRecord {
	readonly version: 1;
	readonly privacyPolicyVersion: string;
	readonly termsVersion: string;
	readonly acceptedAt: string;
}

function isIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
		!Number.isNaN(Date.parse(value))
	);
}

function isCurrentConsent(value: unknown): value is ConsentRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !==
		"acceptedAt,privacyPolicyVersion,termsVersion,version"
	) {
		return false;
	}
	return (
		record.version === 1 &&
		record.privacyPolicyVersion === PRIVACY_POLICY_VERSION &&
		record.termsVersion === TERMS_VERSION &&
		isIsoTimestamp(record.acceptedAt)
	);
}

function isWithdrawalTombstone(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	return record.version === 0 && record.withdrawn === true;
}

/**
 * Process-wide privacy gate. Every remote feature checks this authority at the
 * point of use; page routing is never treated as the security boundary.
 */
export class PrivacyConsentAuthority {
	private allowed = false;

	constructor(private readonly storage: ConsentStorage) {
		this.allowed = this.readPersistedConsent();
	}

	isAllowed(): boolean {
		return this.allowed;
	}

	requireAllowed(): void {
		if (!this.allowed) throw new Error("PRIVACY_CONSENT_REQUIRED");
	}

	accept(now: Date = new Date(), retryPendingCleanup?: () => void): boolean {
		this.allowed = false;
		const record: ConsentRecord = Object.freeze({
			version: 1,
			privacyPolicyVersion: PRIVACY_POLICY_VERSION,
			termsVersion: TERMS_VERSION,
			acceptedAt: now.toISOString(),
		});
		try {
			const pendingWithdrawal = this.hasPendingWithdrawal();
			if (retryPendingCleanup !== undefined) {
				retryPendingCleanup();
			} else if (pendingWithdrawal) {
				return false;
			}
			if (pendingWithdrawal) {
				// Invalidate the old consent before removing the withdrawal marker. If
				// either operation fails, the next launch must remain fail-closed.
				this.storage.removeStorageSync(CONSENT_STORAGE_KEY);
				if (
					isCurrentConsent(this.storage.getStorageSync(CONSENT_STORAGE_KEY))
				) {
					return false;
				}
				this.storage.removeStorageSync(WITHDRAWAL_STORAGE_KEY);
				if (this.hasPendingWithdrawal()) return false;
			}
			this.storage.setStorageSync(CONSENT_STORAGE_KEY, record);
			if (!isCurrentConsent(this.storage.getStorageSync(CONSENT_STORAGE_KEY))) {
				return false;
			}
			this.allowed = true;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Closes authority before clearing account and local decision state. If any
	 * storage operation fails, the durable withdrawal marker keeps next launch
	 * fail-closed.
	 */
	withdraw(clearSensitiveLocalState: () => void): boolean {
		this.allowed = false;
		let withdrawalMarkerPersisted = false;
		let consentInvalidated = false;
		let cleared = true;
		try {
			this.storage.setStorageSync(WITHDRAWAL_STORAGE_KEY, {
				version: 1,
				withdrawnAt: new Date().toISOString(),
			});
			withdrawalMarkerPersisted = true;
		} catch {
			// In-process authority is already closed.
		}
		try {
			clearSensitiveLocalState();
		} catch {
			cleared = false;
		} finally {
			try {
				this.storage.removeStorageSync(CONSENT_STORAGE_KEY);
				consentInvalidated = !isCurrentConsent(
					this.storage.getStorageSync(CONSENT_STORAGE_KEY),
				);
			} catch {
				try {
					this.storage.setStorageSync(CONSENT_STORAGE_KEY, {
						version: 0,
						withdrawn: true,
					});
					consentInvalidated = isWithdrawalTombstone(
						this.storage.getStorageSync(CONSENT_STORAGE_KEY),
					);
				} catch {
					// The caller receives false and the in-process authority remains closed.
				}
			}
		}
		if (!cleared) {
			try {
				this.storage.setStorageSync(CONSENT_STORAGE_KEY, {
					version: 0,
					withdrawn: true,
				});
				consentInvalidated = isWithdrawalTombstone(
					this.storage.getStorageSync(CONSENT_STORAGE_KEY),
				);
			} catch {
				// A successfully persisted primary marker still keeps restart closed.
			}
		}
		return (withdrawalMarkerPersisted || consentInvalidated) && cleared;
	}

	private readPersistedConsent(): boolean {
		try {
			if (this.hasPendingWithdrawal()) return false;
			return isCurrentConsent(this.storage.getStorageSync(CONSENT_STORAGE_KEY));
		} catch {
			return false;
		}
	}

	private hasPendingWithdrawal(): boolean {
		try {
			const withdrawal = this.storage.getStorageSync(WITHDRAWAL_STORAGE_KEY);
			return (
				(withdrawal !== undefined &&
					withdrawal !== null &&
					withdrawal !== "") ||
				isWithdrawalTombstone(this.storage.getStorageSync(CONSENT_STORAGE_KEY))
			);
		} catch {
			return true;
		}
	}
}
