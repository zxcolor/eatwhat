import { describe, expect, it, vi } from "vitest";

import { ApiError, type AuthApi } from "./api-client";
import {
	type AuthRuntimeCapabilities,
	AuthSessionService,
} from "./auth-session";
import type {
	AuthTokenResponse,
	IdentityBindingsResponse,
	SessionsResponse,
} from "./contracts";
import { InstallationStore, type SecureRandomPort } from "./installation";
import { RefreshSessionStore, type StoragePort } from "./session-store";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const CHALLENGE_ID = "44444444-4444-4444-8444-444444444444";
const ACCESS_TOKEN = "a".repeat(43);
const REFRESH_TOKEN = "r".repeat(43);
const ROTATED_REFRESH_TOKEN = "n".repeat(43);
const FUTURE = "2099-01-01T00:00:00.000Z";

const TOKENS: AuthTokenResponse = Object.freeze({
	userId: USER_ID,
	sessionId: SESSION_ID,
	tokenType: "Bearer",
	accessToken: ACCESS_TOKEN,
	accessTokenExpiresAt: FUTURE,
	refreshToken: REFRESH_TOKEN,
	refreshTokenExpiresAt: FUTURE,
});

const IDENTITIES: IdentityBindingsResponse = Object.freeze({
	items: Object.freeze([
		Object.freeze({
			bindingId: BINDING_ID,
			type: "PHONE" as const,
			maskedValue: "+86138****0000",
			boundAt: "2026-01-01T00:00:00.000Z",
			primary: true,
			canUnbind: false,
		}),
	]),
});

const SESSIONS: SessionsResponse = Object.freeze({
	items: Object.freeze([
		Object.freeze({
			sessionId: SESSION_ID,
			deviceLabel: "微信小程序",
			platform: "MINIPROGRAM" as const,
			current: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			lastActiveAt: "2026-01-01T00:00:00.000Z",
			expiresAt: FUTURE,
		}),
	]),
});

function unavailable(): Promise<never> {
	return Promise.reject(new Error("UNEXPECTED_API_CALL"));
}

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
	return {
		requestPhoneCode: unavailable,
		requestEmailCode: unavailable,
		createOAuthState: unavailable,
		loginPhone: unavailable,
		loginEmail: unavailable,
		loginWechat: unavailable,
		refresh: unavailable,
		logout: unavailable,
		listIdentities: unavailable,
		bindEmail: unavailable,
		listSessions: unavailable,
		revokeSession: unavailable,
		requestAccountExport: unavailable,
		getLatestAccountExport: unavailable,
		getAccountExport: unavailable,
		deleteAccount: unavailable,
		...overrides,
	};
}

function testStorage(): {
	readonly state: Map<string, unknown>;
	readonly storage: StoragePort;
} {
	const state = new Map<string, unknown>();
	return {
		state,
		storage: {
			getStorageSync: (key) => state.get(key),
			setStorageSync: (key, value) => state.set(key, value),
			removeStorageSync: (key) => state.delete(key),
		},
	};
}

function secureRandom(): SecureRandomPort {
	return {
		getRandomValues(options) {
			options.success({ randomValues: new Uint8Array(16).buffer });
		},
	};
}

function service(
	api: AuthApi,
	storage: StoragePort,
	login = vi.fn(),
	capabilities?: () => AuthRuntimeCapabilities | null,
): AuthSessionService {
	return new AuthSessionService(
		api,
		{ login },
		new InstallationStore(storage, secureRandom()),
		new RefreshSessionStore(storage),
		"0.1.0",
		capabilities,
	);
}

describe("AuthSessionService", () => {
	it.each(["restore", "accessToken"] as const)(
		"clears a rejected refresh during %s without treating it as a suspension race",
		async (operation) => {
			const { storage } = testStorage();
			const refreshStore = new RefreshSessionStore(storage);
			refreshStore.save({
				refreshToken: REFRESH_TOKEN,
				refreshTokenExpiresAt: FUTURE,
			});
			const auth = service(
				authApi({
					refresh: async () => {
						throw new ApiError("HTTP_ERROR", 401, "SESSION_EXPIRED");
					},
				}),
				storage,
			);
			if (operation === "restore")
				await expect(auth.restore()).resolves.toEqual({ kind: "SIGNED_OUT" });
			else await expect(auth.accessToken()).resolves.toBeNull();
			expect(refreshStore.load()).toBeNull();
			expect(auth.currentAccessToken()).toBeNull();
		},
	);

	it("displays an existing QQ binding without invoking a third-party login", async () => {
		const { storage } = testStorage();
		const loginWechat = vi.fn(unavailable);
		const auth = service(
			authApi({
				loginPhone: async () => TOKENS,
				loginWechat,
				listIdentities: async () => ({
					items: [
						...IDENTITIES.items,
						{
							bindingId: "55555555-5555-4555-8555-555555555555",
							type: "QQ",
							maskedValue: "QQ 账号",
							boundAt: "2026-01-01T00:00:00.000Z",
							primary: false,
							canUnbind: true,
						},
					],
				}),
				listSessions: async () => SESSIONS,
			}),
			storage,
		);
		const result = await auth.loginWithPhone(
			"+8613800000000",
			CHALLENGE_ID,
			"123456",
		);
		expect(result).toMatchObject({
			kind: "SIGNED_IN",
			account: {
				bindings: expect.arrayContaining([
					{ type: "QQ", label: "QQ 账号", primary: false },
				]),
			},
		});
		expect(loginWechat).not.toHaveBeenCalled();
	});

	it("suspends memory state and restores using the persisted rotating refresh token", async () => {
		const { storage } = testStorage();
		const refreshStore = new RefreshSessionStore(storage);
		const refresh = vi.fn(async () => ({
			...TOKENS,
			refreshToken: ROTATED_REFRESH_TOKEN,
		}));
		const auth = service(
			authApi({
				loginPhone: async () => TOKENS,
				refresh,
				listIdentities: async () => IDENTITIES,
				listSessions: async () => SESSIONS,
			}),
			storage,
		);
		await auth.loginWithPhone("+8613800000000", CHALLENGE_ID, "123456");
		auth.suspend();
		expect(auth.currentAccessToken()).toBeNull();
		expect(refreshStore.load()?.refreshToken).toBe(REFRESH_TOKEN);
		await expect(auth.restore()).resolves.toMatchObject({ kind: "SIGNED_IN" });
		expect(refresh).toHaveBeenCalledWith(REFRESH_TOKEN, expect.any(String));
		expect(refreshStore.load()?.refreshToken).toBe(ROTATED_REFRESH_TOKEN);
	});

	it.each(["success", "unauthorized"] as const)(
		"ignores a stale refresh %s after suspension and a new foreground restore",
		async (outcome) => {
			const { storage } = testStorage();
			const refreshStore = new RefreshSessionStore(storage);
			refreshStore.save({
				refreshToken: REFRESH_TOKEN,
				refreshTokenExpiresAt: FUTURE,
			});
			let resolveOld: (value: AuthTokenResponse) => void = () => {
				throw new Error("refresh not started");
			};
			let rejectOld: (reason: unknown) => void = () => {
				throw new Error("refresh not started");
			};
			const refresh = vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<AuthTokenResponse>((resolve, reject) => {
							resolveOld = resolve;
							rejectOld = reject;
						}),
				)
				.mockResolvedValueOnce({
					...TOKENS,
					refreshToken: ROTATED_REFRESH_TOKEN,
				});
			const auth = service(
				authApi({
					refresh,
					listIdentities: async () => IDENTITIES,
					listSessions: async () => SESSIONS,
				}),
				storage,
			);
			const stale = auth.restore();
			await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
			auth.suspend();
			await expect(auth.restore()).resolves.toMatchObject({
				kind: "SIGNED_IN",
			});
			if (outcome === "success") resolveOld(TOKENS);
			else rejectOld(new ApiError("HTTP_ERROR", 401, "SESSION_EXPIRED"));
			await expect(stale).resolves.toMatchObject({ kind: "ERROR" });
			expect(refreshStore.load()?.refreshToken).toBe(ROTATED_REFRESH_TOKEN);
			expect(auth.currentAccessToken()).toBe(ACCESS_TOKEN);
		},
	);

	it("prevents an in-flight login from persisting tokens after suspension", async () => {
		const { storage } = testStorage();
		const refreshStore = new RefreshSessionStore(storage);
		let resolveLogin: (value: AuthTokenResponse) => void = () => {
			throw new Error("login not started");
		};
		const loginPhone = vi.fn(
			() =>
				new Promise<AuthTokenResponse>((resolve) => {
					resolveLogin = resolve;
				}),
		);
		const auth = service(authApi({ loginPhone }), storage);
		const pending = auth.loginWithPhone(
			"+8613800000000",
			CHALLENGE_ID,
			"123456",
		);
		await vi.waitFor(() => expect(loginPhone).toHaveBeenCalledOnce());
		auth.suspend();
		resolveLogin(TOKENS);
		await expect(pending).resolves.toMatchObject({ kind: "ERROR" });
		expect(refreshStore.load()).toBeNull();
		expect(auth.currentAccessToken()).toBeNull();
	});

	it("signs in with a phone challenge, syncs account evidence and persists no access token", async () => {
		const { state, storage } = testStorage();
		const loginPhone = vi.fn(async () => TOKENS);
		const auth = service(
			authApi({
				loginPhone,
				listIdentities: vi.fn(async () => IDENTITIES),
				listSessions: vi.fn(async () => SESSIONS),
			}),
			storage,
		);

		const result = await auth.loginWithPhone(
			"+8613800000000",
			CHALLENGE_ID,
			"123456",
		);

		expect(result).toMatchObject({
			kind: "SIGNED_IN",
			account: {
				hasPhoneBinding: true,
				hasEmailBinding: false,
				hasWechatBinding: false,
			},
		});
		expect(loginPhone).toHaveBeenCalledWith(
			"+8613800000000",
			CHALLENGE_ID,
			"123456",
			expect.objectContaining({ platform: "MINIPROGRAM", label: "微信小程序" }),
		);
		expect(auth.currentAccessToken()).toBe(ACCESS_TOKEN);
		await expect(auth.accessToken()).resolves.toBe(ACCESS_TOKEN);
		const persisted = JSON.stringify(state.get("chi-shen-me.auth.refresh.v1"));
		expect(persisted).toContain(REFRESH_TOKEN);
		expect(persisted).not.toContain(ACCESS_TOKEN);

		auth.invalidate();
		expect(auth.currentAccessToken()).toBeNull();
		await expect(auth.accessToken()).resolves.toBeNull();
	});

	it("rotates a persisted refresh token before returning a reusable access token", async () => {
		const { state, storage } = testStorage();
		new RefreshSessionStore(storage).save({
			refreshToken: REFRESH_TOKEN,
			refreshTokenExpiresAt: FUTURE,
		});
		const refresh = vi.fn(async () => ({
			...TOKENS,
			refreshToken: ROTATED_REFRESH_TOKEN,
		}));
		const auth = service(authApi({ refresh }), storage);

		await expect(auth.accessToken()).resolves.toBe(ACCESS_TOKEN);

		expect(refresh).toHaveBeenCalledWith(
			REFRESH_TOKEN,
			"00000000-0000-4000-8000-000000000000",
		);
		expect(JSON.stringify(state.get("chi-shen-me.auth.refresh.v1"))).toContain(
			ROTATED_REFRESH_TOKEN,
		);
	});

	it("does not let an in-flight refresh recreate a session after invalidate", async () => {
		const { state, storage } = testStorage();
		new RefreshSessionStore(storage).save({
			refreshToken: REFRESH_TOKEN,
			refreshTokenExpiresAt: FUTURE,
		});
		let resolveRefresh: ((value: AuthTokenResponse) => void) | null = null;
		const refresh = vi.fn(
			() =>
				new Promise<AuthTokenResponse>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const auth = service(authApi({ refresh }), storage);

		const pending = auth.accessToken();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		auth.invalidate();
		if (resolveRefresh === null) throw new Error("REFRESH_NOT_STARTED");
		resolveRefresh(TOKENS);

		await expect(pending).rejects.toThrow("SESSION_INVALIDATED");
		expect(auth.currentAccessToken()).toBeNull();
		expect(state.has("chi-shen-me.auth.refresh.v1")).toBe(false);
	});

	it("never exposes an expired in-memory access token to synchronous feature clients", async () => {
		const { storage } = testStorage();
		const auth = service(
			authApi({
				loginPhone: vi.fn(async () => ({
					...TOKENS,
					accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
				})),
				listIdentities: vi.fn(async () => IDENTITIES),
				listSessions: vi.fn(async () => SESSIONS),
			}),
			storage,
		);

		await auth.loginWithPhone("+8613800000000", CHALLENGE_ID, "123456");

		expect(auth.currentAccessToken()).toBeNull();
	});

	it("maps an unbound email to a non-creating account result", async () => {
		const { storage } = testStorage();
		const auth = service(
			authApi({
				loginEmail: vi.fn(async () => {
					throw new ApiError("HTTP_ERROR", 401, "IDENTITY_NOT_BOUND");
				}),
			}),
			storage,
		);

		await expect(auth.loginWithEmail(CHALLENGE_ID, "123456")).resolves.toEqual({
			kind: "IDENTITY_NOT_BOUND",
			method: "EMAIL",
		});
	});

	it("reports post-login sync failure without discarding a valid new session", async () => {
		const { storage } = testStorage();
		const auth = service(
			authApi({
				loginPhone: vi.fn(async () => TOKENS),
				listIdentities: vi.fn(async () => {
					throw new ApiError("NETWORK");
				}),
				listSessions: vi.fn(async () => SESSIONS),
			}),
			storage,
		);

		await expect(
			auth.loginWithPhone("+8613800000000", CHALLENGE_ID, "123456"),
		).resolves.toEqual({ kind: "SYNC_FAILED" });
		expect(auth.currentAccessToken()).toBe(ACCESS_TOKEN);
	});

	it("keeps WeChat login disabled before installation, OAuth or wx.login work begins", async () => {
		const { storage } = testStorage();
		const wxLogin = vi.fn();
		const createOAuthState = vi.fn(unavailable);
		const auth = service(authApi({ createOAuthState }), storage, wxLogin);

		await expect(auth.loginWithWechat()).resolves.toEqual({
			kind: "FEATURE_DISABLED",
		});
		expect(wxLogin).not.toHaveBeenCalled();
		expect(createOAuthState).not.toHaveBeenCalled();
	});

	it("does not create an installation or call auth APIs while capabilities are unconfirmed", async () => {
		const { storage } = testStorage();
		const requestPhoneCode = vi.fn(unavailable);
		const auth = service(
			authApi({ requestPhoneCode }),
			storage,
			vi.fn(),
			() => null,
		);

		await expect(
			auth.requestPhoneChallenge("+8613800000000", "LOGIN"),
		).rejects.toMatchObject({ status: 403, code: "FEATURE_DISABLED" });
		expect(requestPhoneCode).not.toHaveBeenCalled();
		expect(
			storage.getStorageSync("chi-shen-me.installation.v1"),
		).toBeUndefined();
	});

	it("does not persist a login response after auth capability is revoked", async () => {
		const { state, storage } = testStorage();
		let enabled = true;
		const loginPhone = vi.fn(async () => {
			enabled = false;
			return TOKENS;
		});
		const auth = service(authApi({ loginPhone }), storage, vi.fn(), () =>
			enabled
				? {
						accountsEnabled: true,
						registrationEnabled: true,
						phoneEnabled: true,
						emailEnabled: true,
						dataExportEnabled: true,
					}
				: null,
		);

		await expect(
			auth.loginWithPhone("+8613800000000", CHALLENGE_ID, "123456"),
		).resolves.toEqual({ kind: "ERROR", retryable: false });
		expect(auth.currentAccessToken()).toBeNull();
		expect(state.has("chi-shen-me.auth.refresh.v1")).toBe(false);
	});

	it("does not send refresh after capability is revoked during installation creation", async () => {
		const { storage } = testStorage();
		new RefreshSessionStore(storage).save({
			refreshToken: REFRESH_TOKEN,
			refreshTokenExpiresAt: FUTURE,
		});
		let enabled = true;
		const refresh = vi.fn(unavailable);
		const auth = new AuthSessionService(
			authApi({ refresh }),
			{ login: vi.fn() },
			new InstallationStore(storage, {
				getRandomValues(options) {
					enabled = false;
					options.success({ randomValues: new Uint8Array(16).buffer });
				},
			}),
			new RefreshSessionStore(storage),
			"0.1.0",
			() =>
				enabled
					? {
							accountsEnabled: true,
							registrationEnabled: true,
							phoneEnabled: true,
							emailEnabled: true,
							dataExportEnabled: true,
						}
					: null,
		);

		await expect(auth.accessToken()).rejects.toMatchObject({
			status: 403,
			code: "FEATURE_DISABLED",
		});
		expect(refresh).not.toHaveBeenCalled();
	});
});
