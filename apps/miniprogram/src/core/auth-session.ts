import type {
	AccountExportDownloader,
	VerifiedExportDownload,
} from "./account-export";
import {
	ApiError,
	type AuthApi,
	type MiniProgramDeviceContext,
} from "./api-client";
import {
	type AccountExportReceipt,
	type AccountExportStatus,
	type AuthTokenResponse,
	type EmailPurpose,
	type IdentityBinding,
	isEmailAddress,
	isMainlandPhone,
	isOtpCode,
	isUuid,
	type OtpChallengeResponse,
	type PhonePurpose,
	type SessionSummary,
} from "./contracts";
import { WECHAT_LOGIN_ENABLED } from "./features";
import type { InstallationStore } from "./installation";
import type { RefreshSessionStore } from "./session-store";
import { requestWechatLoginCode } from "./wechat-code";

export interface BindingSummary {
	readonly type: IdentityBinding["type"];
	readonly label: string;
	readonly primary: boolean;
}

export interface SessionDisplay {
	readonly sessionId: string;
	readonly label: string;
	readonly platformLabel: string;
	readonly current: boolean;
	readonly lastActiveAt: string;
	readonly expiresAt: string;
}

export interface AccountSnapshot {
	readonly bindings: readonly BindingSummary[];
	readonly sessions: readonly SessionDisplay[];
	readonly hasPhoneBinding: boolean;
	readonly hasWechatBinding: boolean;
	readonly hasEmailBinding: boolean;
}

export type AuthFlowResult =
	| { readonly kind: "SIGNED_IN"; readonly account: AccountSnapshot }
	| { readonly kind: "SIGNED_OUT" }
	| { readonly kind: "IDENTITY_NOT_BOUND"; readonly method: "EMAIL" | "WECHAT" }
	| { readonly kind: "FEATURE_DISABLED" }
	| { readonly kind: "SYNC_FAILED" }
	| { readonly kind: "ERROR"; readonly retryable: boolean };

export interface AuthRuntimeCapabilities {
	readonly accountsEnabled: boolean;
	readonly registrationEnabled: boolean;
	readonly phoneEnabled: boolean;
	readonly emailEnabled: boolean;
	readonly dataExportEnabled: boolean;
}

const DEFAULT_AUTH_CAPABILITIES: AuthRuntimeCapabilities = Object.freeze({
	accountsEnabled: true,
	registrationEnabled: true,
	phoneEnabled: true,
	emailEnabled: true,
	dataExportEnabled: true,
});

interface LoginRuntime {
	login(options: {
		timeout?: number;
		success(result: WxLoginResult): void;
		fail(): void;
	}): void;
}

interface MemorySession {
	readonly userId: string;
	readonly sessionId: string;
	readonly accessToken: string;
	readonly accessTokenExpiresAt: string;
}

function bindingLabel(binding: IdentityBinding): string {
	if (binding.type === "PHONE") return `手机号 ${binding.maskedValue}`;
	if (binding.type === "EMAIL") return `邮箱 ${binding.maskedValue}`;
	if (binding.type === "QQ") return "QQ 账号";
	return "微信账号";
}

function summarizeBindings(
	bindings: readonly IdentityBinding[],
): readonly BindingSummary[] {
	return Object.freeze(
		bindings.map((binding) =>
			Object.freeze({
				type: binding.type,
				label: bindingLabel(binding),
				primary: binding.primary,
			}),
		),
	);
}

function summarizeSessions(
	sessions: readonly SessionSummary[],
): readonly SessionDisplay[] {
	return Object.freeze(
		sessions.map((session) =>
			Object.freeze({
				sessionId: session.sessionId,
				label: session.deviceLabel,
				platformLabel:
					session.platform === "MINIPROGRAM" ? "微信小程序" : "Android",
				current: session.current,
				lastActiveAt: session.lastActiveAt,
				expiresAt: session.expiresAt,
			}),
		),
	);
}

export function normalizeMainlandPhone(value: string): string | null {
	const compact = value.trim().replace(/[\s-]/gu, "");
	const normalized = compact.startsWith("+86") ? compact : `+86${compact}`;
	return isMainlandPhone(normalized) ? normalized : null;
}

export function normalizeEmail(value: string): string | null {
	const normalized = value.trim();
	return isEmailAddress(normalized) ? normalized : null;
}

export class AuthSessionService {
	private memorySession: MemorySession | null = null;
	private refreshInFlight: Promise<AuthTokenResponse> | null = null;
	private sessionRevision = 0;

	constructor(
		private readonly api: AuthApi,
		private readonly loginRuntime: LoginRuntime,
		private readonly installationStore: InstallationStore,
		private readonly refreshStore: RefreshSessionStore,
		private readonly appVersion: string,
		private readonly runtimeCapabilities: () => AuthRuntimeCapabilities | null = () =>
			DEFAULT_AUTH_CAPABILITIES,
	) {}

	async restore(): Promise<AuthFlowResult> {
		const expectedRevision = this.sessionRevision;
		if (!this.capabilitiesAvailable()) return { kind: "FEATURE_DISABLED" };
		const stored = this.refreshStore.load();
		if (stored === null) return { kind: "SIGNED_OUT" };
		if (Date.parse(stored.refreshTokenExpiresAt) <= Date.now()) {
			this.clearLocalSession();
			return { kind: "SIGNED_OUT" };
		}
		try {
			await this.refresh(stored.refreshToken);
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status === 401 &&
				this.memorySession === null &&
				this.refreshStore.load() === null
			) {
				return { kind: "SIGNED_OUT" };
			}
			if (expectedRevision !== this.sessionRevision)
				return { kind: "ERROR", retryable: true };
			if (error instanceof ApiError && error.status === 401) {
				this.clearLocalSession();
				return { kind: "SIGNED_OUT" };
			}
			return { kind: "ERROR", retryable: true };
		}
		return this.finishAuthenticatedLogin(expectedRevision);
	}

	async accessToken(): Promise<string | null> {
		const expectedRevision = this.sessionRevision;
		if (!this.capabilitiesAvailable()) return null;
		if (this.memorySession === null && this.refreshStore.load() === null)
			return null;
		try {
			return await this.ensureAccessToken();
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status === 401 &&
				this.memorySession === null &&
				this.refreshStore.load() === null
			)
				return null;
			this.assertRevision(expectedRevision);
			if (error instanceof ApiError && error.status === 401) {
				this.clearLocalSession();
				return null;
			}
			throw error;
		}
	}

	currentAccessToken(): string | null {
		if (
			!this.capabilitiesAvailable() ||
			this.memorySession === null ||
			Date.parse(this.memorySession.accessTokenExpiresAt) <= Date.now()
		) {
			return null;
		}
		return this.memorySession.accessToken;
	}

	invalidate(): void {
		this.clearLocalSession();
	}

	// Backgrounding drops sensitive in-memory state while retaining the latest
	// persisted refresh credential for a subsequent foreground restore.
	suspend(): void {
		this.sessionRevision += 1;
		this.memorySession = null;
		this.refreshInFlight = null;
	}

	async requestPhoneChallenge(
		phoneNumber: string,
		purpose: PhonePurpose,
	): Promise<OtpChallengeResponse> {
		const expectedRevision = this.sessionRevision;
		if (!isMainlandPhone(phoneNumber)) throw new Error("PHONE_INVALID");
		this.requireCapabilities(
			"phoneEnabled",
			...(purpose === "REGISTER" ? (["registrationEnabled"] as const) : []),
		);
		const installationId = await this.installationStore.getOrCreate();
		this.assertRevision(expectedRevision);
		this.requireCapabilities(
			"phoneEnabled",
			...(purpose === "REGISTER" ? (["registrationEnabled"] as const) : []),
		);
		return this.api.requestPhoneCode(phoneNumber, purpose, installationId);
	}

	async loginWithPhone(
		phoneNumber: string,
		challengeId: string,
		otpCode: string,
		purpose: PhonePurpose = "LOGIN",
	): Promise<AuthFlowResult> {
		if (
			!this.capabilitiesAvailable(
				"phoneEnabled",
				...(purpose === "REGISTER" ? (["registrationEnabled"] as const) : []),
			)
		) {
			return { kind: "FEATURE_DISABLED" };
		}
		if (
			!isMainlandPhone(phoneNumber) ||
			!isUuid(challengeId) ||
			!isOtpCode(otpCode)
		) {
			return { kind: "ERROR", retryable: true };
		}
		const expectedRevision = this.sessionRevision;
		try {
			const device = await this.device();
			this.assertRevision(expectedRevision);
			this.requireCapabilities(
				"phoneEnabled",
				...(purpose === "REGISTER" ? (["registrationEnabled"] as const) : []),
			);
			const session = await this.api.loginPhone(
				phoneNumber,
				challengeId,
				otpCode,
				device,
			);
			this.requireCapabilities(
				"phoneEnabled",
				...(purpose === "REGISTER" ? (["registrationEnabled"] as const) : []),
			);
			this.acceptSession(session, expectedRevision);
		} catch (error) {
			return {
				kind: "ERROR",
				retryable: !(error instanceof ApiError) || error.status !== 403,
			};
		}
		return this.finishAuthenticatedLogin(expectedRevision);
	}

	async requestEmailChallenge(
		email: string,
		purpose: EmailPurpose,
	): Promise<OtpChallengeResponse> {
		const expectedRevision = this.sessionRevision;
		if (!isEmailAddress(email)) throw new Error("EMAIL_INVALID");
		this.requireCapabilities("emailEnabled");
		const installationId = await this.installationStore.getOrCreate();
		this.assertRevision(expectedRevision);
		this.requireCapabilities("emailEnabled");
		if (purpose === "LOGIN") {
			return this.api.requestEmailCode(email, purpose, installationId);
		}
		return this.withAccessToken((accessToken) => {
			this.requireCapabilities("emailEnabled");
			return this.api.requestEmailCode(
				email,
				purpose,
				installationId,
				accessToken,
			);
		});
	}

	async loginWithEmail(
		challengeId: string,
		otpCode: string,
	): Promise<AuthFlowResult> {
		if (!this.capabilitiesAvailable("emailEnabled")) {
			return { kind: "FEATURE_DISABLED" };
		}
		if (!isUuid(challengeId) || !isOtpCode(otpCode)) {
			return { kind: "ERROR", retryable: true };
		}
		const expectedRevision = this.sessionRevision;
		try {
			const device = await this.device();
			this.assertRevision(expectedRevision);
			this.requireCapabilities("emailEnabled");
			const session = await this.api.loginEmail(challengeId, otpCode, device);
			this.requireCapabilities("emailEnabled");
			this.acceptSession(session, expectedRevision);
		} catch (error) {
			if (expectedRevision !== this.sessionRevision)
				return { kind: "ERROR", retryable: true };
			return this.mapLoginFailure(error, "EMAIL");
		}
		return this.finishAuthenticatedLogin(expectedRevision);
	}

	async bindEmail(
		challengeId: string,
		otpCode: string,
	): Promise<AccountSnapshot> {
		if (!isUuid(challengeId) || !isOtpCode(otpCode))
			throw new Error("OTP_INVALID");
		this.requireCapabilities("emailEnabled");
		await this.withAccessToken((accessToken) => {
			this.requireCapabilities("emailEnabled");
			return this.api.bindEmail(accessToken, challengeId, otpCode);
		});
		this.requireCapabilities("emailEnabled");
		return this.readAccountSnapshot();
	}

	async loginWithWechat(): Promise<AuthFlowResult> {
		if (!WECHAT_LOGIN_ENABLED) return { kind: "FEATURE_DISABLED" };
		const expectedRevision = this.sessionRevision;
		const installationId = await this.installationStore.getOrCreate();
		try {
			const authorizationCode = await requestWechatLoginCode(this.loginRuntime);
			const oauth = await this.api.createOAuthState(installationId, "LOGIN");
			const session = await this.api.loginWechat(
				oauth.state,
				authorizationCode,
				await this.device(installationId),
			);
			this.acceptSession(session, expectedRevision);
		} catch (error) {
			return this.mapLoginFailure(error, "WECHAT");
		}
		return this.finishAuthenticatedLogin(expectedRevision);
	}

	async syncAccount(): Promise<AuthFlowResult> {
		if (!this.capabilitiesAvailable()) return { kind: "FEATURE_DISABLED" };
		try {
			return { kind: "SIGNED_IN", account: await this.readAccountSnapshot() };
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) {
				this.clearLocalSession();
				return { kind: "SIGNED_OUT" };
			}
			return { kind: "SYNC_FAILED" };
		}
	}

	async revokeSession(sessionId: string): Promise<AccountSnapshot> {
		if (!isUuid(sessionId)) throw new Error("SESSION_ID_INVALID");
		this.requireCapabilities();
		await this.withAccessToken((accessToken) =>
			this.api.revokeSession(accessToken, sessionId),
		);
		return this.readAccountSnapshot();
	}

	async requestAccountExport(
		includeHistory: boolean,
	): Promise<AccountExportReceipt> {
		this.requireCapabilities("dataExportEnabled");
		const receipt = await this.withAccessToken((accessToken) => {
			this.requireCapabilities("dataExportEnabled");
			return this.api.requestAccountExport(accessToken, includeHistory);
		});
		this.requireCapabilities("dataExportEnabled");
		return receipt;
	}

	async getLatestAccountExport(): Promise<AccountExportStatus | null> {
		this.requireCapabilities("dataExportEnabled");
		const response = await this.withAccessToken((accessToken) => {
			this.requireCapabilities("dataExportEnabled");
			return this.api.getLatestAccountExport(accessToken);
		});
		this.requireCapabilities("dataExportEnabled");
		return response.item;
	}

	async getAccountExport(exportId: string): Promise<AccountExportStatus> {
		if (!isUuid(exportId)) throw new Error("EXPORT_ID_INVALID");
		this.requireCapabilities("dataExportEnabled");
		const status = await this.withAccessToken((accessToken) => {
			this.requireCapabilities("dataExportEnabled");
			return this.api.getAccountExport(accessToken, exportId);
		});
		this.requireCapabilities("dataExportEnabled");
		return status;
	}

	async downloadAccountExport(
		status: Extract<AccountExportStatus, { status: "READY" }>,
		downloader: AccountExportDownloader,
	): Promise<VerifiedExportDownload> {
		this.requireCapabilities("dataExportEnabled");
		const result = await this.withAccessToken((accessToken) => {
			this.requireCapabilities("dataExportEnabled");
			return downloader.download(status, accessToken);
		});
		this.requireCapabilities("dataExportEnabled");
		return result;
	}

	async deleteAccount(): Promise<{ readonly backupDeletionDeadline: string }> {
		this.requireCapabilities();
		await this.ensureAccessToken();
		const expectedUserId = this.memorySession?.userId ?? null;
		if (expectedUserId === null) throw new Error("SESSION_ACCOUNT_UNKNOWN");
		const response = await this.withAccessToken((accessToken) =>
			this.api.deleteAccount(accessToken),
		);
		if (response.userId !== expectedUserId) {
			this.clearLocalSession();
			throw new Error("ACCOUNT_DELETION_MISMATCH");
		}
		this.clearLocalSession();
		return { backupDeletionDeadline: response.backupDeletionDeadline };
	}

	async logout(): Promise<{ readonly remoteConfirmed: boolean }> {
		if (!this.capabilitiesAvailable()) {
			this.clearLocalSession();
			return { remoteConfirmed: false };
		}
		let remoteConfirmed = false;
		try {
			const accessToken = await this.ensureAccessToken();
			await this.api.logout(accessToken);
			remoteConfirmed = true;
		} catch {
			// Local logout is authoritative for this device even when the server is unreachable.
		} finally {
			this.clearLocalSession();
		}
		return { remoteConfirmed };
	}

	private async readAccountSnapshot(): Promise<AccountSnapshot> {
		const [identityResponse, sessionResponse] = await this.withAccessToken(
			(accessToken) =>
				Promise.all([
					this.api.listIdentities(accessToken),
					this.api.listSessions(accessToken),
				]),
		);
		const bindings = summarizeBindings(identityResponse.items);
		const types = new Set(bindings.map((binding) => binding.type));
		return Object.freeze({
			bindings,
			sessions: summarizeSessions(sessionResponse.items),
			hasPhoneBinding: types.has("PHONE"),
			hasWechatBinding: types.has("WECHAT"),
			hasEmailBinding: types.has("EMAIL"),
		});
	}

	private async withAccessToken<T>(
		operation: (accessToken: string) => Promise<T>,
	): Promise<T> {
		const expectedRevision = this.sessionRevision;
		const accessToken = await this.ensureAccessToken();
		this.assertRevision(expectedRevision);
		try {
			const value = await operation(accessToken);
			this.assertRevision(expectedRevision);
			this.requireCapabilities();
			return value;
		} catch (error) {
			this.assertRevision(expectedRevision);
			if (!(error instanceof ApiError) || error.status !== 401) throw error;
			const stored = this.refreshStore.load();
			if (stored === null) {
				this.clearLocalSession();
				throw error;
			}
			const session = await this.refresh(stored.refreshToken);
			this.assertRevision(expectedRevision);
			try {
				const value = await operation(session.accessToken);
				this.assertRevision(expectedRevision);
				this.requireCapabilities();
				return value;
			} catch (retryError) {
				this.assertRevision(expectedRevision);
				if (retryError instanceof ApiError && retryError.status === 401) {
					this.clearLocalSession();
				}
				throw retryError;
			}
		}
	}

	private async ensureAccessToken(): Promise<string> {
		this.requireCapabilities();
		if (
			this.memorySession !== null &&
			Date.parse(this.memorySession.accessTokenExpiresAt) > Date.now() + 15_000
		) {
			return this.memorySession.accessToken;
		}
		const stored = this.refreshStore.load();
		if (
			stored === null ||
			Date.parse(stored.refreshTokenExpiresAt) <= Date.now()
		) {
			this.clearLocalSession();
			throw new ApiError("HTTP_ERROR", 401, "SESSION_EXPIRED");
		}
		return (await this.refresh(stored.refreshToken)).accessToken;
	}

	private refresh(refreshToken: string): Promise<AuthTokenResponse> {
		if (this.refreshInFlight !== null) return this.refreshInFlight;
		const previousUserId = this.memorySession?.userId ?? null;
		const expectedRevision = this.sessionRevision;
		let operation: Promise<AuthTokenResponse>;
		operation = this.installationStore
			.getOrCreate()
			.then((installationId) => {
				this.assertRevision(expectedRevision);
				this.requireCapabilities();
				return this.api.refresh(refreshToken, installationId);
			})
			.then((session) => {
				this.assertRevision(expectedRevision);
				if (previousUserId !== null && previousUserId !== session.userId) {
					this.clearLocalSession();
					throw new Error("SESSION_ACCOUNT_CHANGED");
				}
				this.acceptSession(session, expectedRevision);
				return session;
			})
			.catch((error: unknown) => {
				if (
					expectedRevision === this.sessionRevision &&
					error instanceof ApiError &&
					error.status === 401
				)
					this.clearLocalSession();
				throw error;
			})
			.finally(() => {
				if (this.refreshInFlight === operation) this.refreshInFlight = null;
			});
		this.refreshInFlight = operation;
		return operation;
	}

	private acceptSession(
		session: AuthTokenResponse,
		expectedRevision: number,
	): void {
		this.requireCapabilities();
		if (expectedRevision !== this.sessionRevision)
			throw new Error("SESSION_INVALIDATED");
		if (
			this.memorySession !== null &&
			this.memorySession.userId !== session.userId
		) {
			this.clearLocalSession();
			throw new Error("SESSION_ACCOUNT_CHANGED");
		}
		this.refreshStore.save({
			refreshToken: session.refreshToken,
			refreshTokenExpiresAt: session.refreshTokenExpiresAt,
		});
		this.memorySession = Object.freeze({
			userId: session.userId,
			sessionId: session.sessionId,
			accessToken: session.accessToken,
			accessTokenExpiresAt: session.accessTokenExpiresAt,
		});
	}

	private clearLocalSession(): void {
		this.suspend();
		this.refreshStore.clear();
	}

	private assertRevision(expectedRevision: number): void {
		if (expectedRevision !== this.sessionRevision)
			throw new Error("SESSION_INVALIDATED");
	}

	private mapLoginFailure(
		error: unknown,
		method: "EMAIL" | "WECHAT",
	): AuthFlowResult {
		if (
			error instanceof ApiError &&
			error.status === 401 &&
			error.code === "IDENTITY_NOT_BOUND"
		) {
			this.clearLocalSession();
			return { kind: "IDENTITY_NOT_BOUND", method };
		}
		return {
			kind: "ERROR",
			retryable: !(error instanceof ApiError) || error.status !== 403,
		};
	}

	private async finishAuthenticatedLogin(
		expectedRevision: number,
	): Promise<AuthFlowResult> {
		try {
			this.assertRevision(expectedRevision);
			const account = await this.readAccountSnapshot();
			if (expectedRevision !== this.sessionRevision)
				return { kind: "SIGNED_OUT" };
			return { kind: "SIGNED_IN", account };
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status === 401 &&
				this.memorySession === null &&
				this.refreshStore.load() === null
			)
				return { kind: "SIGNED_OUT" };
			if (expectedRevision !== this.sessionRevision)
				return { kind: "ERROR", retryable: true };
			if (error instanceof ApiError && error.status === 401) {
				this.clearLocalSession();
				return { kind: "SIGNED_OUT" };
			}
			return { kind: "SYNC_FAILED" };
		}
	}

	private async device(
		installationId?: string,
	): Promise<MiniProgramDeviceContext> {
		return Object.freeze({
			installationId:
				installationId ?? (await this.installationStore.getOrCreate()),
			label: "微信小程序",
			platform: "MINIPROGRAM",
			appVersion: this.appVersion,
		});
	}

	private capabilitiesAvailable(
		...required: readonly (keyof Omit<
			AuthRuntimeCapabilities,
			"accountsEnabled"
		>)[]
	): boolean {
		const capabilities = this.runtimeCapabilities();
		return (
			capabilities?.accountsEnabled === true &&
			required.every((key) => capabilities[key])
		);
	}

	private requireCapabilities(
		...required: readonly (keyof Omit<
			AuthRuntimeCapabilities,
			"accountsEnabled"
		>)[]
	): void {
		if (!this.capabilitiesAvailable(...required)) {
			throw new ApiError("HTTP_ERROR", 403, "FEATURE_DISABLED");
		}
	}
}
