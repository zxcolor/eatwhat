import { readBoundedIdentityJson } from "./bounded-identity-json.js";
import {
	ExternalIdentityUnavailableError,
	hasUnsafeCredentialCharacters,
	type QqAuthorizationProof,
	type QqIdentityProvider,
	type VerifiedExternalIdentity,
} from "./external-identity.provider.js";

const QQ_TOKEN_ENDPOINT = "https://graph.qq.com/oauth2.0/token";
const QQ_IDENTITY_ENDPOINT = "https://graph.qq.com/oauth2.0/me";
const QQ_SERVER_SIDE_REDIRECT_URI = "auth://tauth.qq.com/";

export interface QqIdentityProviderConfig {
	readonly enabled: boolean;
	readonly unionIdEnabled: boolean;
	readonly appId: string | null;
	readonly appKey: string | null;
	readonly timeoutMs: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundedIdentifier(value: unknown, maximum: number): string | null {
	return typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		/^[A-Za-z0-9_-]+$/u.test(value)
		? value
		: null;
}

function boundedCredential(value: unknown): string | null {
	return typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 2_048 &&
		!hasUnsafeCredentialCharacters(value)
		? value
		: null;
}

function positiveLifetimeSeconds(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^[1-9][0-9]{0,8}$/u.test(value)
				? Number(value)
				: Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 315_360_000
		? parsed
		: null;
}

function isRejectedPayload(body: Record<string, unknown>): boolean {
	return (
		body.error !== undefined ||
		body.error_description !== undefined ||
		(body.ret !== undefined && body.ret !== 0)
	);
}

export class OfficialQqIdentityProvider implements QqIdentityProvider {
	constructor(
		private readonly config: QqIdentityProviderConfig,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async verify(proof: QqAuthorizationProof): Promise<VerifiedExternalIdentity> {
		const { appId, appKey } = this.config;
		if (!this.config.enabled || appId === null || appKey === null) {
			throw new ExternalIdentityUnavailableError("DISABLED");
		}
		if (
			proof.authorizationCode.length < 1 ||
			proof.authorizationCode.length > 2_048 ||
			hasUnsafeCredentialCharacters(proof.authorizationCode)
		) {
			throw new ExternalIdentityUnavailableError("INVALID_PROOF");
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			const accessToken = await this.exchangeAuthorizationCode(
				proof.authorizationCode,
				appId,
				appKey,
				controller.signal,
			);
			return await this.fetchIdentity(accessToken, appId, controller.signal);
		} catch (error) {
			if (error instanceof ExternalIdentityUnavailableError) throw error;
			throw new ExternalIdentityUnavailableError(
				controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async exchangeAuthorizationCode(
		authorizationCode: string,
		appId: string,
		appKey: string,
		signal: AbortSignal,
	): Promise<string> {
		const endpoint = new URL(QQ_TOKEN_ENDPOINT);
		endpoint.searchParams.set("grant_type", "authorization_code");
		endpoint.searchParams.set("client_id", appId);
		endpoint.searchParams.set("client_secret", appKey);
		endpoint.searchParams.set("code", authorizationCode);
		endpoint.searchParams.set("redirect_uri", QQ_SERVER_SIDE_REDIRECT_URI);
		endpoint.searchParams.set("fmt", "json");

		// Tencent's documented server-side exchange carries the AppKey in this
		// fixed HTTPS request. Never log this URL or propagate transport errors.
		const response = await this.fetchImpl(endpoint, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal,
			cache: "no-store",
			redirect: "error",
			referrerPolicy: "no-referrer",
		});
		if (!response.ok) {
			throw new ExternalIdentityUnavailableError("UPSTREAM_HTTP");
		}
		const body = objectValue(await readBoundedIdentityJson(response, signal));
		if (body === null) {
			throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
		}
		if (isRejectedPayload(body)) {
			throw new ExternalIdentityUnavailableError("UPSTREAM_REJECTED");
		}

		const accessToken = boundedCredential(body.access_token);
		const refreshToken = boundedCredential(body.refresh_token);
		const expiresIn = positiveLifetimeSeconds(body.expires_in);
		if (accessToken === null || refreshToken === null || expiresIn === null) {
			throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
		}
		// The refresh token is deliberately validated and discarded. Neither token
		// leaves this adapter, reaches persistence, or appears in an error value.
		void refreshToken;
		void expiresIn;
		return accessToken;
	}

	private async fetchIdentity(
		accessToken: string,
		appId: string,
		signal: AbortSignal,
	): Promise<VerifiedExternalIdentity> {
		const endpoint = new URL(QQ_IDENTITY_ENDPOINT);
		endpoint.searchParams.set("access_token", accessToken);
		endpoint.searchParams.set("fmt", "json");
		if (this.config.unionIdEnabled) endpoint.searchParams.set("unionid", "1");

		const response = await this.fetchImpl(endpoint, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal,
			cache: "no-store",
			redirect: "error",
			referrerPolicy: "no-referrer",
		});
		if (!response.ok) {
			throw new ExternalIdentityUnavailableError("UPSTREAM_HTTP");
		}
		const body = objectValue(await readBoundedIdentityJson(response, signal));
		if (body === null) {
			throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
		}
		if (isRejectedPayload(body)) {
			throw new ExternalIdentityUnavailableError("UPSTREAM_REJECTED");
		}

		const clientId = boundedIdentifier(body.client_id, 128);
		const openId = boundedIdentifier(body.openid, 256);
		// An unrequested UnionID is not part of the configured proof contract.
		// Ignore it completely so a supplier-side response expansion cannot
		// silently change the durable identity deduplication domain.
		const unionId = this.config.unionIdEnabled
			? boundedIdentifier(body.unionid, 256)
			: null;
		if (
			clientId === null ||
			openId === null ||
			(this.config.unionIdEnabled && unionId === null)
		) {
			throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
		}
		if (clientId !== appId) {
			throw new ExternalIdentityUnavailableError("UPSTREAM_REJECTED");
		}
		return Object.freeze({
			provider: "QQ" as const,
			providerScope: appId,
			subject: openId,
			unionSubject: unionId,
		});
	}
}
