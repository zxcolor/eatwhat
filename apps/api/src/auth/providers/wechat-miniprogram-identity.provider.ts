import { readBoundedIdentityJson } from "./bounded-identity-json.js";
import {
	ExternalIdentityUnavailableError,
	hasUnsafeCredentialCharacters,
	type VerifiedExternalIdentity,
	type WechatAuthorizationProof,
	type WechatIdentityProvider,
} from "./external-identity.provider.js";
import type { WechatIdentityProviderConfig } from "./wechat-identity.provider.js";

function identifier(value: unknown): string | null {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(value)
		? value
		: null;
}

/** Only the dedicated Mini Program server credentials can reach code2Session. */
export class OfficialWechatMiniProgramIdentityProvider
	implements WechatIdentityProvider
{
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
		const endpoint = new URL("https://api.weixin.qq.com/sns/jscode2session");
		endpoint.searchParams.set("appid", this.config.appId);
		endpoint.searchParams.set("secret", this.config.appSecret);
		endpoint.searchParams.set("js_code", proof.authorizationCode);
		endpoint.searchParams.set("grant_type", "authorization_code");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			// The official HTTPS query is never logged or retained in an exception.
			const response = await this.fetchImpl(endpoint, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: controller.signal,
				cache: "no-store",
				redirect: "error",
				referrerPolicy: "no-referrer",
			});
			if (!response.ok)
				throw new ExternalIdentityUnavailableError("UPSTREAM_HTTP");
			const raw = await readBoundedIdentityJson(response, controller.signal);
			if (typeof raw !== "object" || raw === null || Array.isArray(raw))
				throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
			const body = raw as Record<string, unknown>;
			if (body.errcode !== undefined && body.errcode !== 0)
				throw new ExternalIdentityUnavailableError("UPSTREAM_REJECTED");
			const openId = identifier(body.openid);
			const unionId =
				body.unionid === undefined ? null : identifier(body.unionid);
			// A session key is required for a valid exchange but is never returned,
			// persisted, logged or used as an application login token.
			if (
				openId === null ||
				(body.unionid !== undefined && unionId === null) ||
				typeof body.session_key !== "string" ||
				!/^[A-Za-z0-9+/]{22}==$/u.test(body.session_key)
			) {
				throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
			}
			return Object.freeze({
				provider: "WECHAT",
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
