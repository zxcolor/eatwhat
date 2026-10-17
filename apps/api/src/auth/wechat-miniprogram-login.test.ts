import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import type {
	AuthRepository,
	OAuthLoginCompletion,
} from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { hashIdentityLookup } from "./auth-crypto.js";
import type { OAuthStateDraft } from "./auth-workflow.types.js";
import type { AuthenticatedUserResolver } from "./authenticated-user.resolver.js";
import { UnavailableExportArtifactReader } from "./data-export-artifact.reader.js";
import {
	ExternalIdentityUnavailableError,
	type VerifiedExternalIdentity,
} from "./providers/external-identity.provider.js";
import {
	UnavailableOtpDeliveryProvider,
	UnavailablePhoneOtpProvider,
} from "./providers/unavailable-otp.provider.js";

const device = {
	installationId: "11111111-2222-4333-8444-555555555555",
	label: "微信小程序",
	platform: "MINIPROGRAM" as const,
	appVersion: "0.1.11-alpha",
};
const userId = "22222222-2222-4333-8444-555555555555";
const code = "synthetic-mini-code";
const miniIdentity: VerifiedExternalIdentity = {
	provider: "WECHAT",
	providerScope: "wx1111111111111111",
	subject: "synthetic_mini_openid",
	unionSubject: "same_union_as_android",
};

function setup(
	options: {
		enabled?: boolean;
		available?: boolean;
		identity?: VerifiedExternalIdentity;
		completion?:
			| "SUCCESS"
			| "INVALID_CREDENTIALS"
			| "IDENTITY_NOT_BOUND"
			| "IDENTITY_CONFLICT";
	} = {},
) {
	const config = loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1/synthetic",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		ALIYUN_PNVS_SIGN_NAME: "synthetic",
		ALIYUN_PNVS_TEMPLATE_CODE: "100001",
		AUTH_HASH_KEYS_JSON: JSON.stringify({
			stable: Buffer.alloc(32, 3).toString("base64"),
			rotating: Buffer.alloc(32, 4).toString("base64"),
		}),
		AUTH_HASH_ACTIVE_VERSION: "rotating",
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "stable",
		WECHAT_MINIPROGRAM_AUTH_ENABLED: String(options.enabled ?? true),
		WECHAT_MINIPROGRAM_APP_ID: miniIdentity.providerScope,
		WECHAT_MINIPROGRAM_APP_SECRET: "synthetic_mini_secret",
		WECHAT_OPEN_PLATFORM_REALM_ID: "eatwhat-primary",
	});
	const seen = new Set<string>();
	const claim = vi.fn(async (draft: OAuthStateDraft) => {
		if (seen.has(draft.stateHash.value)) return { kind: "REPLAY" as const };
		seen.add(draft.stateHash.value);
		return { kind: "CREATED" as const };
	});
	const complete = vi.fn(async (input: OAuthLoginCompletion) => {
		const kind = options.completion ?? "SUCCESS";
		return kind === "SUCCESS"
			? { kind, userId, sessionId: input.session.sessionId }
			: { kind };
	});
	const repository = {
		isAvailable: () => options.available ?? true,
		claimWechatMiniProgramCode: claim,
		completeWechatMiniProgramLogin: complete,
	} as unknown as AuthRepository;
	const mini = { verify: vi.fn(async () => options.identity ?? miniIdentity) };
	const native = {
		verify: vi.fn(async () => {
			throw new Error("native provider must not run");
		}),
	};
	const service = new AuthService(
		config,
		repository,
		new UnavailablePhoneOtpProvider(),
		new UnavailableOtpDeliveryProvider("EMAIL"),
		native,
		native,
		{} as AuthenticatedUserResolver,
		new UnavailableExportArtifactReader(),
		mini,
	);
	return { config, claim, complete, mini, native, service };
}

describe("Mini Program login reuses the existing UnionID account", () => {
	it("uses app-scoped OpenID hashes and the same stable UnionID alias; issues MINIPROGRAM session", async () => {
		const h = setup();
		const result = await h.service.loginWechatMiniProgram(
			{ code, device },
			"192.0.2.1",
		);
		expect(result.userId).toBe(userId);
		expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(h.native.verify).not.toHaveBeenCalled();
		expect(h.mini.verify).toHaveBeenCalledWith({ authorizationCode: code });
		const draft = h.claim.mock.calls[0]?.[0] as OAuthStateDraft;
		const completion = h.complete.mock.calls[0]?.[0] as OAuthLoginCompletion;
		expect(draft.stateHash.keyVersion).toBe("stable");
		expect(completion.proof).toMatchObject({
			provider: "WECHAT",
			purpose: "LOGIN",
			targetUserId: null,
			operationTargetHash: null,
			id: draft.id,
		});
		expect(completion.session.device.platform).toBe("MINIPROGRAM");
		const ring = h.config.auth.hashKeyRing;
		if (ring === null) throw new Error("test keyring absent");
		expect(completion.verifiedIdentity.lookup).toEqual(
			hashIdentityLookup(
				"WECHAT",
				miniIdentity.providerScope,
				miniIdentity.subject,
				ring,
			),
		);
		expect(completion.verifiedIdentity.wechatUnionAlias).toEqual({
			realmId: "eatwhat-primary",
			hash: hashIdentityLookup(
				"WECHAT",
				"open-platform:eatwhat-primary",
				miniIdentity.unionSubject as string,
				ring,
				"stable",
			),
		});
		for (const sensitive of [
			code,
			miniIdentity.subject,
			miniIdentity.unionSubject as string,
			"synthetic_mini_secret",
			"192.0.2.1",
		]) {
			expect(JSON.stringify([draft, completion, result])).not.toContain(
				sensitive,
			);
		}
	});
	it("claims a code once even when replay changes the device and source IP", async () => {
		const h = setup();
		const first = h.service.loginWechatMiniProgram(
			{ code, device },
			"192.0.2.1",
		);
		const replay = h.service.loginWechatMiniProgram(
			{
				code,
				device: {
					...device,
					installationId: "33333333-2222-4333-8444-555555555555",
				},
			},
			"192.0.2.2",
		);
		await expect(replay).rejects.toMatchObject({
			response: { code: "INVALID_CREDENTIALS" },
		});
		await first;
		expect(h.mini.verify).toHaveBeenCalledTimes(1);
		expect(h.complete).toHaveBeenCalledTimes(1);
	});
	it("rejects absent UnionID without issuing a session or falling back to OpenID", async () => {
		const h = setup({ identity: { ...miniIdentity, unionSubject: null } });
		await expect(
			h.service.loginWechatMiniProgram({ code, device }, "192.0.2.1"),
		).rejects.toMatchObject({ response: { code: "IDENTITY_NOT_BOUND" } });
		expect(h.complete).not.toHaveBeenCalled();
	});
	it.each([
		["IDENTITY_NOT_BOUND", "IDENTITY_NOT_BOUND"],
		["INVALID_CREDENTIALS", "INVALID_CREDENTIALS"],
		["IDENTITY_CONFLICT", "IDENTITY_BINDING_CONFLICT"],
	] as const)("keeps %s closed", async (completion, expected) => {
		const h = setup({ completion });
		await expect(
			h.service.loginWechatMiniProgram({ code, device }, "192.0.2.1"),
		).rejects.toMatchObject({ response: { code: expected } });
	});
	it.each([{ enabled: false }, { available: false }])(
		"does not claim or exchange when unavailable: %j",
		async (options) => {
			const h = setup(options);
			await expect(
				h.service.loginWechatMiniProgram({ code, device }, "192.0.2.1"),
			).rejects.toMatchObject({
				response: { code: "AUTH_CHANNEL_UNAVAILABLE" },
			});
			expect(h.claim).not.toHaveBeenCalled();
			expect(h.mini.verify).not.toHaveBeenCalled();
		},
	);
	it("requires the verified provider scope to match the configured Mini Program", async () => {
		const h = setup({
			identity: { ...miniIdentity, providerScope: "wx2222222222222222" },
		});
		await expect(
			h.service.loginWechatMiniProgram({ code, device }, "192.0.2.1"),
		).rejects.toMatchObject({ response: { code: "AUTH_CHANNEL_UNAVAILABLE" } });
		expect(h.complete).not.toHaveBeenCalled();
	});
	it("maps official replay/invalid-code rejection without exposing upstream data", async () => {
		const h = setup();
		h.mini.verify.mockRejectedValue(
			new ExternalIdentityUnavailableError("UPSTREAM_REJECTED"),
		);
		await expect(
			h.service.loginWechatMiniProgram({ code, device }, "192.0.2.1"),
		).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
		expect(h.complete).not.toHaveBeenCalled();
	});
});
