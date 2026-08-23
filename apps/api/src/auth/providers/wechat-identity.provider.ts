import { readBoundedIdentityJson } from "./bounded-identity-json.js";
import {
	ExternalIdentityUnavailableError,
	hasUnsafeCredentialCharacters,
	type VerifiedExternalIdentity,
	type WechatAuthorizationProof,
	type WechatIdentityProvider,
} from "./external-identity.provider.js";

export interface WechatIdentityProviderConfig {
	readonly enabled: boolean;
	readonly appId: string | null;
	readonly appSecret: string | null;
	readonly timeoutMs: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundedString(
	value: unknown,
	maximum: number,
	pattern?: RegExp,
): string | null {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
		return null;
	}
	return pattern === undefined || pattern.test(value) ? value : null;
}

export class OfficialWechatIdentityProvider implements WechatIdentityProvider {
	constructor(
		private readonly config: WechatIdentityProviderConfig,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async verify(
		proof: WechatAuthorizationProof,
	): Promise<VerifiedExternalIdentity> {
		if (
			!this.config.enabled ||
			this.config.appId === null ||
			this.config.appSecret === null
		) {
			throw new ExternalIdentityUnavailableError("DISABLED");
		}
		if (
			proof.authorizationCode.length < 1 ||
			proof.authorizationCode.length > 512 ||
			hasUnsafeCredentialCharacters(proof.authorizationCode)
		) {
			throw new ExternalIdentityUnavailableError("INVALID_PROOF");
		}

		const endpoint = new URL(
			"https://api.weixin.qq.com/sns/oauth2/access_token",
		);
		endpoint.searchParams.set("appid", this.config.appId);
		endpoint.searchParams.set("secret", this.config.appSecret);
		endpoint.searchParams.set("code", proof.authorizationCode);
		endpoint.searchParams.set("grant_type", "authorization_code");

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			// The official API requires AppSecret and code in its HTTPS query. The URL
			// is never logged, returned or attached to an application exception.
			const response = await this.fetchImpl(endpoint, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: controller.signal,
				cache: "no-store",
				redirect: "error",
				referrerPolicy: "no-referrer",
			});
			if (!response.ok) {
				throw new ExternalIdentityUnavailableError("UPSTREAM_HTTP");
			}
			const raw = await readBoundedIdentityJson(response, controller.signal);
			const body = objectValue(raw);
			if (body === null) {
				throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
			}
			if (body.errcode !== undefined) {
				throw new ExternalIdentityUnavailableError("UPSTREAM_REJECTED");
			}

			const accessToken = boundedString(body.access_token, 2_048);
			const refreshToken = boundedString(body.refresh_token, 2_048);
			const expiresIn = body.expires_in;
			const openId = boundedString(body.openid, 256, /^[A-Za-z0-9_-]+$/u);
			const scope = boundedString(body.scope, 256);
			const unionId =
				body.unionid === undefined
					? null
					: boundedString(body.unionid, 256, /^[A-Za-z0-9_-]+$/u);
			if (
				accessToken === null ||
				refreshToken === null ||
				typeof expiresIn !== "number" ||
				!Number.isSafeInteger(expiresIn) ||
				expiresIn <= 0 ||
				openId === null ||
				scope === null ||
				!scope.split(",").includes("snsapi_userinfo") ||
				(body.unionid !== undefined && unionId === null)
			) {
				throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
			}

			return Object.freeze({
				provider: "WECHAT" as const,
				providerScope: this.config.appId,
				subject: openId,
				unionSubject: unionId,
			});
		} catch (error) {
			if (error instanceof ExternalIdentityUnavailableError) throw error;
			throw new ExternalIdentityUnavailableError(
				controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}
