import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { AuthRepository } from "./auth.repository.js";
import { DatabaseAuthenticatedUserResolver } from "./authenticated-user.resolver.js";

const accessToken = "T".repeat(43);
const installationId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";

function config() {
	const hashKey = Buffer.alloc(32, 17).toString("base64");
	const otpPepper = Buffer.alloc(32, 18).toString("base64");
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		EMAIL_AUTH_ENABLED: "false",
		WECHAT_AUTH_ENABLED: "true",
		QQ_AUTH_ENABLED: "false",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_PNVS_SIGN_NAME: "test-sign",
		ALIYUN_PNVS_TEMPLATE_CODE: "100001",
		WECHAT_APP_ID: "wx0123456789abcdef",
		WECHAT_APP_SECRET: "private-provider-secret",
		WECHAT_OPEN_PLATFORM_REALM_ID: "eatwhat-primary",
	});
}

function repository(
	authenticateAccess: AuthRepository["authenticateAccess"],
): AuthRepository {
	return {
		isAvailable: () => true,
		authenticateAccess,
	} as AuthRepository;
}

describe("DatabaseAuthenticatedUserResolver", () => {
	it("owns Bearer parsing, hashes token and device, and returns only minimal context", async () => {
		const authenticateAccess = vi.fn(async () => ({
			userId: "3bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			sessionId: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			deviceHash: "a".repeat(64),
			hashKeyVersion: "v1",
		}));
		const resolver = new DatabaseAuthenticatedUserResolver(
			config(),
			repository(authenticateAccess),
		);
		const context = await resolver.resolveAuthorization(
			`Bearer ${accessToken}`,
			installationId,
		);
		expect(context).toEqual({
			userId: "3bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			sessionId: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			deviceHash: "a".repeat(64),
		});
		const persistenceCall = JSON.stringify(authenticateAccess.mock.calls);
		expect(persistenceCall).not.toContain(accessToken);
		expect(persistenceCall).not.toContain(installationId);
		expect(persistenceCall).toMatch(/[0-9a-f]{64}/u);
	});

	it.each([undefined, "", `Basic ${accessToken}`, `Bearer  ${accessToken}`])(
		"rejects a missing or malformed Authorization header without a DB lookup",
		async (header) => {
			const authenticateAccess = vi.fn();
			const resolver = new DatabaseAuthenticatedUserResolver(
				config(),
				repository(authenticateAccess),
			);
			await expect(resolver.resolveAuthorization(header)).rejects.toMatchObject(
				{
					status: 401,
				},
			);
			expect(authenticateAccess).not.toHaveBeenCalled();
		},
	);

	it("fails closed for expired, revoked or deleted sessions", async () => {
		const resolver = new DatabaseAuthenticatedUserResolver(
			config(),
			repository(async () => null),
		);
		await expect(
			resolver.resolveAccessToken(accessToken),
		).rejects.toMatchObject({
			status: 401,
			response: expect.objectContaining({ code: "SESSION_EXPIRED" }),
		});
	});

	it("maps database failure to a non-reflective 503", async () => {
		const resolver = new DatabaseAuthenticatedUserResolver(
			config(),
			repository(async () => {
				throw new Error("postgresql://private-host/raw-token");
			}),
		);
		let failure: unknown;
		try {
			await resolver.resolveAccessToken(accessToken);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ status: 503 });
		expect(JSON.stringify(failure)).not.toContain("private-host");
		expect(JSON.stringify(failure)).not.toContain(accessToken);
	});
});
