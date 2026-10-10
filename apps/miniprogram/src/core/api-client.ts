import {
	type AccountExportReceipt,
	type AccountExportStatus,
	type AuthTokenResponse,
	type BindIdentityResponse,
	CONTRACT_VERSION,
	CONTRACT_VERSION_HEADER,
	type DeleteAccountResponse,
	type EmailPurpose,
	type IdentityBindingsResponse,
	type LatestAccountExportResponse,
	type OAuthStateResponse,
	type OtpChallengeResponse,
	type PhonePurpose,
	parseAccountExportReceipt,
	parseAccountExportStatus,
	parseAuthTokenResponse,
	parseBindIdentityResponse,
	parseDeleteAccountResponse,
	parseEmailChallengeResponse,
	parseIdentityBindingsResponse,
	parseLatestAccountExportResponse,
	parseMutationAcknowledgement,
	parseOAuthStateResponse,
	parsePhoneChallengeResponse,
	parseSessionsResponse,
	type SessionsResponse,
} from "./contracts";

export type ApiErrorKind =
	| "NETWORK"
	| "PRIVACY_REQUIRED"
	| "CONTRACT_INCOMPATIBLE"
	| "INVALID_RESPONSE"
	| "HTTP_ERROR";

export class ApiError extends Error {
	constructor(
		readonly kind: ApiErrorKind,
		readonly status: number | null = null,
		readonly code: string | null = null,
	) {
		super(kind);
		this.name = "ApiError";
	}
}

export interface RequestRuntime {
	request(options: {
		url: string;
		method: "GET" | "POST" | "DELETE";
		data?: unknown;
		header: Record<string, string>;
		timeout: number;
		success(result: WxRequestResult): void;
		fail(): void;
	}): unknown;
}

export interface HttpRequestTask {
	abort?(): void;
}

export interface HttpRequest<T> {
	readonly method: "GET" | "POST" | "DELETE";
	readonly path: `/${string}`;
	readonly query?: Readonly<
		Record<string, string | number | boolean | undefined>
	>;
	readonly body?: unknown;
	readonly bearer?: string | null;
	readonly parser: (value: unknown) => T;
	readonly timeoutMs?: number;
}

function contractHeader(
	headers: Record<string, unknown> | undefined,
): string | null {
	if (headers === undefined) return null;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === CONTRACT_VERSION_HEADER.toLowerCase()) {
			return typeof value === "string" ? value : null;
		}
	}
	return null;
}

function safeProblemCode(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const code = (value as Record<string, unknown>).code;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)
		? code
		: null;
}

function queryString(query: HttpRequest<unknown>["query"]): string {
	if (query === undefined) return "";
	const entries = Object.entries(query)
		.filter(
			(entry): entry is [string, string | number | boolean] =>
				entry[1] !== undefined,
		)
		.sort(([left], [right]) => left.localeCompare(right));
	if (entries.length === 0) return "";
	return `?${entries
		.map(
			([key, value]) =>
				`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
		)
		.join("&")}`;
}

export class HttpApi {
	private readonly pending = new Set<() => void>();

	constructor(
		private readonly runtime: RequestRuntime,
		readonly baseUrl: string,
		private readonly remoteAccessAllowed: () => boolean = () => true,
	) {}

	abortAll(): void {
		for (const cancel of [...this.pending]) cancel();
	}

	request<T>(input: HttpRequest<T>): Promise<T> {
		if (!this.remoteAccessAllowed()) {
			return Promise.reject(
				new ApiError("PRIVACY_REQUIRED", null, "PRIVACY_CONSENT_REQUIRED"),
			);
		}
		if (!/^\/v1(?:\/|$)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(input.path)) {
			return Promise.reject(new ApiError("INVALID_RESPONSE"));
		}
		if (input.method === "GET" && input.body !== undefined) {
			return Promise.reject(new ApiError("INVALID_RESPONSE"));
		}
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
			[CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
		};
		if (input.bearer !== undefined && input.bearer !== null) {
			headers.Authorization = `Bearer ${input.bearer}`;
		}
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let task: HttpRequestTask | null = null;
			const finish = (operation: () => void) => {
				if (settled) return;
				settled = true;
				this.pending.delete(cancel);
				operation();
			};
			const cancel = () => {
				if (settled) return;
				finish(() =>
					reject(
						new ApiError("PRIVACY_REQUIRED", null, "PRIVACY_CONSENT_REQUIRED"),
					),
				);
				try {
					task?.abort?.();
				} catch {
					// The local promise is closed; late callbacks are ignored.
				}
			};
			this.pending.add(cancel);
			const options = {
				url: `${this.baseUrl}${input.path}${queryString(input.query)}`,
				method: input.method,
				header: headers,
				timeout: input.timeoutMs ?? 10_000,
				success: (response: WxRequestResult) => {
					if (settled) return;
					if (!this.remoteAccessAllowed()) {
						cancel();
						return;
					}
					if (contractHeader(response.header) !== CONTRACT_VERSION) {
						finish(() =>
							reject(
								new ApiError("CONTRACT_INCOMPATIBLE", response.statusCode),
							),
						);
						return;
					}
					if (response.statusCode < 200 || response.statusCode >= 300) {
						finish(() =>
							reject(
								new ApiError(
									"HTTP_ERROR",
									response.statusCode,
									safeProblemCode(response.data),
								),
							),
						);
						return;
					}
					try {
						const parsed = input.parser(response.data);
						finish(() => resolve(parsed));
					} catch {
						finish(() =>
							reject(new ApiError("INVALID_RESPONSE", response.statusCode)),
						);
					}
				},
				fail: () => finish(() => reject(new ApiError("NETWORK"))),
			};
			try {
				const requestTask = this.runtime.request(
					input.body === undefined ? options : { ...options, data: input.body },
				);
				if (
					typeof requestTask === "object" &&
					requestTask !== null &&
					"abort" in requestTask
				) {
					task = requestTask as HttpRequestTask;
				}
			} catch {
				finish(() => reject(new ApiError("NETWORK")));
			}
		});
	}
}

export interface MiniProgramDeviceContext {
	readonly installationId: string;
	readonly label: string;
	readonly platform: "MINIPROGRAM";
	readonly appVersion: string;
}

export interface AuthApi {
	requestPhoneCode(
		phoneNumber: string,
		purpose: PhonePurpose,
		installationId: string,
	): Promise<OtpChallengeResponse>;
	requestEmailCode(
		email: string,
		purpose: EmailPurpose,
		installationId: string,
		accessToken?: string,
	): Promise<OtpChallengeResponse>;
	createOAuthState(
		installationId: string,
		purpose: "LOGIN" | "BIND",
		accessToken?: string,
	): Promise<OAuthStateResponse>;
	loginPhone(
		phoneNumber: string,
		challengeId: string,
		otpCode: string,
		device: MiniProgramDeviceContext,
	): Promise<AuthTokenResponse>;
	loginEmail(
		challengeId: string,
		otpCode: string,
		device: MiniProgramDeviceContext,
	): Promise<AuthTokenResponse>;
	loginWechat(
		oauthState: string,
		authorizationCode: string,
		device: MiniProgramDeviceContext,
	): Promise<AuthTokenResponse>;
	refresh(
		refreshToken: string,
		installationId: string,
	): Promise<AuthTokenResponse>;
	logout(accessToken: string): Promise<void>;
	listIdentities(accessToken: string): Promise<IdentityBindingsResponse>;
	bindEmail(
		accessToken: string,
		challengeId: string,
		otpCode: string,
	): Promise<BindIdentityResponse>;
	listSessions(accessToken: string): Promise<SessionsResponse>;
	revokeSession(accessToken: string, sessionId: string): Promise<void>;
	requestAccountExport(
		accessToken: string,
		includeHistory: boolean,
	): Promise<AccountExportReceipt>;
	getLatestAccountExport(
		accessToken: string,
	): Promise<LatestAccountExportResponse>;
	getAccountExport(
		accessToken: string,
		exportId: string,
	): Promise<AccountExportStatus>;
	deleteAccount(accessToken: string): Promise<DeleteAccountResponse>;
}

export class WechatMiniProgramApi implements AuthApi {
	constructor(private readonly http: HttpApi) {}

	requestPhoneCode(
		phoneNumber: string,
		purpose: PhonePurpose,
		installationId: string,
	): Promise<OtpChallengeResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/phone/request-code",
			body: { phoneNumber, purpose, installationId },
			parser: parsePhoneChallengeResponse,
		});
	}

	requestEmailCode(
		email: string,
		purpose: EmailPurpose,
		installationId: string,
		accessToken?: string,
	): Promise<OtpChallengeResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/email/request-code",
			body: { email, purpose, installationId },
			bearer: accessToken ?? null,
			parser: parseEmailChallengeResponse,
		});
	}

	createOAuthState(
		installationId: string,
		purpose: "LOGIN" | "BIND",
		accessToken?: string,
	): Promise<OAuthStateResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/oauth/state",
			body: {
				provider: "WECHAT",
				purpose,
				installationId,
				clientPlatform: "MINIPROGRAM",
			},
			bearer: accessToken ?? null,
			parser: parseOAuthStateResponse,
		});
	}

	loginPhone(
		phoneNumber: string,
		challengeId: string,
		otpCode: string,
		device: MiniProgramDeviceContext,
	): Promise<AuthTokenResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/login",
			body: { method: "PHONE", phoneNumber, challengeId, otpCode, device },
			parser: parseAuthTokenResponse,
		});
	}

	loginEmail(
		challengeId: string,
		otpCode: string,
		device: MiniProgramDeviceContext,
	): Promise<AuthTokenResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/login",
			body: { method: "EMAIL", challengeId, otpCode, device },
			parser: parseAuthTokenResponse,
		});
	}

	loginWechat(
		oauthState: string,
		authorizationCode: string,
		device: MiniProgramDeviceContext,
	): Promise<AuthTokenResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/login",
			body: { method: "WECHAT", oauthState, authorizationCode, device },
			parser: parseAuthTokenResponse,
		});
	}

	refresh(
		refreshToken: string,
		installationId: string,
	): Promise<AuthTokenResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/refresh",
			body: { refreshToken, installationId },
			parser: parseAuthTokenResponse,
		});
	}

	async logout(accessToken: string): Promise<void> {
		await this.http.request({
			method: "POST",
			path: "/v1/auth/logout",
			body: {},
			bearer: accessToken,
			parser: (value) =>
				parseMutationAcknowledgement(value, "sessionId", "loggedOutAt"),
		});
	}

	listIdentities(accessToken: string): Promise<IdentityBindingsResponse> {
		return this.http.request({
			method: "GET",
			path: "/v1/auth/identities",
			bearer: accessToken,
			parser: parseIdentityBindingsResponse,
		});
	}

	bindEmail(
		accessToken: string,
		challengeId: string,
		otpCode: string,
	): Promise<BindIdentityResponse> {
		return this.http.request({
			method: "POST",
			path: "/v1/auth/identities",
			body: { type: "EMAIL", challengeId, otpCode },
			bearer: accessToken,
			parser: parseBindIdentityResponse,
		});
	}

	listSessions(accessToken: string): Promise<SessionsResponse> {
		return this.http.request({
			method: "GET",
			path: "/v1/auth/sessions",
			query: { includePlatforms: "ALL" },
			bearer: accessToken,
			parser: parseSessionsResponse,
		});
	}

	async revokeSession(accessToken: string, sessionId: string): Promise<void> {
		await this.http.request({
			method: "DELETE",
			path: `/v1/auth/sessions/${sessionId}`,
			bearer: accessToken,
			parser: (value) =>
				parseMutationAcknowledgement(value, "sessionId", "revokedAt"),
		});
	}

	requestAccountExport(
		accessToken: string,
		includeHistory: boolean,
	): Promise<AccountExportReceipt> {
		return this.http.request({
			method: "POST",
			path: "/v1/account/export",
			body: { format: "JSON", includeBehaviorHistory: includeHistory },
			bearer: accessToken,
			parser: parseAccountExportReceipt,
		});
	}

	getLatestAccountExport(
		accessToken: string,
	): Promise<LatestAccountExportResponse> {
		return this.http.request({
			method: "GET",
			path: "/v1/account/exports/latest",
			bearer: accessToken,
			parser: parseLatestAccountExportResponse,
		});
	}

	getAccountExport(
		accessToken: string,
		exportId: string,
	): Promise<AccountExportStatus> {
		return this.http.request({
			method: "GET",
			path: `/v1/account/exports/${exportId}`,
			bearer: accessToken,
			parser: parseAccountExportStatus,
		});
	}

	deleteAccount(accessToken: string): Promise<DeleteAccountResponse> {
		return this.http.request({
			method: "DELETE",
			path: "/v1/account",
			body: { confirmation: "DELETE_MY_ACCOUNT" },
			bearer: accessToken,
			parser: parseDeleteAccountResponse,
		});
	}
}
