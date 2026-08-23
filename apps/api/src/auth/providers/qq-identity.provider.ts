import { readBoundedIdentityJson } from "./bounded-identity-json.js";
import {
	ExternalIdentityUnavailableError,
	hasUnsafeCredentialCharacters,
	type QqAuthorizationProof,
	type QqIdentityProvider,
	type VerifiedExternalIdentity,
} from "./external-identity.provider.js";

export interface QqIdentityProviderConfig {
	readonly enabled: boolean;
	readonly appId: string | null;
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

export class OfficialQqIdentityProvider implements QqIdentityProvider {
	constructor(
		private readonly config: QqIdentityProviderConfig,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async verify(proof: QqAuthorizationProof): Promise<VerifiedExternalIdentity> {
		if (!this.config.enabled || this.config.appId === null) {
			throw new ExternalIdentityUnavailableError("DISABLED");
		}
		if (
			proof.accessToken.length < 1 ||
			proof.accessToken.length > 2_048 ||
			hasUnsafeCredentialCharacters(proof.accessToken)
		) {
			throw new ExternalIdentityUnavailableError("INVALID_PROOF");
		}

		const endpoint = new URL("https://graph.qq.com/oauth2.0/me");
		endpoint.searchParams.set("access_token", proof.accessToken);
		endpoint.searchParams.set("fmt", "json");

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			// QQ's official endpoint also accepts the temporary credential only as a
			// query. Never log this URL or copy transport errors into diagnostics.
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
			if (
				body.error !== undefined ||
				(body.ret !== undefined && body.ret !== 0)
			) {
				throw new ExternalIdentityUnavailableError("UPSTREAM_REJECTED");
			}

			const clientId = boundedIdentifier(body.client_id, 128);
			const openId = boundedIdentifier(body.openid, 256);
			if (clientId === null || openId === null) {
				throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
			}
			if (clientId !== this.config.appId) {
				throw new ExternalIdentityUnavailableError("UPSTREAM_REJECTED");
			}
			return Object.freeze({
				provider: "QQ" as const,
				providerScope: this.config.appId,
				subject: openId,
				unionSubject: null,
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
