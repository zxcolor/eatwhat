export type ExternalIdentityProviderCode = "WECHAT" | "QQ";

export interface VerifiedExternalIdentity {
	readonly provider: ExternalIdentityProviderCode;
	readonly providerScope: string;
	readonly subject: string;
	readonly unionSubject: string | null;
}

export type ExternalIdentityFailureReason =
	| "DISABLED"
	| "INVALID_PROOF"
	| "TIMEOUT"
	| "UPSTREAM_HTTP"
	| "UPSTREAM_REJECTED"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR";

export class ExternalIdentityUnavailableError extends Error {
	constructor(readonly reason: ExternalIdentityFailureReason) {
		super("第三方身份服务暂时不可用");
		this.name = "ExternalIdentityUnavailableError";
	}
}

export interface WechatAuthorizationProof {
	readonly authorizationCode: string;
}

export interface QqAuthorizationProof {
	readonly accessToken: string;
}

export interface WechatIdentityProvider {
	verify(proof: WechatAuthorizationProof): Promise<VerifiedExternalIdentity>;
}

export interface QqIdentityProvider {
	verify(proof: QqAuthorizationProof): Promise<VerifiedExternalIdentity>;
}

export function hasUnsafeCredentialCharacters(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
	});
}
