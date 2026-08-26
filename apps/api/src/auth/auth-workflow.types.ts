import type { AuthDeviceContext } from "@chi-shen-me/contracts";
import type { VersionedHash } from "./auth-crypto.js";

export type AuthIdentityType = "PHONE" | "EMAIL" | "WECHAT" | "QQ";
export type AuthOtpPurpose = "REGISTER" | "LOGIN" | "BIND" | "RECOVERY";
export type AuthOAuthPurpose = "REGISTER" | "LOGIN" | "BIND";

export interface AuthenticatedSession {
	readonly userId: string;
	readonly sessionId: string;
	readonly deviceHash: string;
	readonly hashKeyVersion: string;
}

export interface OtpChallengeDraft {
	readonly id: string;
	readonly channel: "PHONE" | "EMAIL";
	readonly purpose: AuthOtpPurpose;
	readonly destinationLookup: VersionedHash;
	readonly destinationDedup: VersionedHash;
	readonly maskedDestination: string;
	readonly operationTargetHash: string | null;
	readonly targetUserId: string | null;
	readonly registrationFlowReferenceHash: string | null;
	readonly codeHash: VersionedHash;
	readonly idempotencyKeyHash: string;
	readonly hashKeyVersion: string;
	readonly requestIpHash: string;
	readonly deviceHash: string;
	readonly createdAt: Date;
	readonly retainUntil: Date;
	readonly expiresAt: Date;
	readonly resendAvailableAt: Date;
}

export type CreateOtpChallengeResult =
	| { readonly kind: "CREATED" }
	| {
			readonly kind: "EXISTING";
			readonly challengeId: string;
			readonly maskedDestination: string;
			readonly expiresAt: Date;
			readonly resendAvailableAt: Date;
	  }
	| { readonly kind: "RATE_LIMITED"; readonly retryAfterSeconds: number };

export interface OtpProof {
	readonly id: string;
	readonly channel: "PHONE" | "EMAIL";
	readonly purpose: AuthOtpPurpose;
	readonly destinationDedupHash: string;
	readonly codeHash: string;
	readonly codeHashKeyVersion: string;
	readonly operationTargetHash: string | null;
	readonly targetUserId: string | null;
	readonly registrationFlowReferenceHash: string | null;
	readonly deviceHash: string;
	readonly hashKeyVersion: string;
}

export interface RegistrationFlowProof {
	readonly registrationFlowReferenceHash: string;
	readonly deviceHash: string;
	readonly hashKeyVersion: string;
}

export interface FusionAuthFlowDraft {
	readonly id: string;
	readonly purpose: "LOGIN" | "REGISTER";
	readonly registrationFlowReferenceHash: string | null;
	readonly requestIpHash: string;
	readonly deviceHash: string;
	readonly hashKeyVersion: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly retainUntil: Date;
}

export interface FusionAuthProof {
	readonly id: string;
	readonly purpose: "LOGIN" | "REGISTER";
	readonly registrationFlowReferenceHash: string | null;
	readonly deviceHash: string;
	readonly hashKeyVersion: string;
	readonly expiresAt: Date;
}

export interface VerifiedFusionAuthProof extends FusionAuthProof {
	readonly registrationFlowReferenceHash: string;
	readonly verifiedPhone: VerifiedFusionPhoneHashes;
	readonly verifiedAt: Date;
}

export interface VerifiedFusionPhoneHashes {
	readonly lookup: VersionedHash;
	readonly dedup: VersionedHash;
	readonly maskedPhone: string;
	readonly verifyTokenHash: VersionedHash;
}

export interface OAuthStateDraft {
	readonly id: string;
	readonly provider: "WECHAT" | "QQ";
	readonly purpose: AuthOAuthPurpose;
	readonly stateHash: VersionedHash;
	readonly flowReferenceHash: string;
	readonly operationTargetHash: string | null;
	readonly targetUserId: string | null;
	readonly deviceHash: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly retainUntil: Date;
}

export type CreateOAuthStateResult =
	| { readonly kind: "CREATED" }
	| { readonly kind: "RATE_LIMITED"; readonly retryAfterSeconds: number };

export interface OAuthProof {
	readonly id: string;
	readonly provider: "WECHAT" | "QQ";
	readonly purpose: AuthOAuthPurpose;
	readonly flowReferenceHash: string;
	readonly operationTargetHash: string | null;
	readonly targetUserId: string | null;
	readonly deviceHash: string;
	readonly hashKeyVersion: string;
}

export interface SessionIssueDraft {
	readonly sessionId: string;
	readonly refreshCredentialId: string;
	readonly accessCredentialId: string;
	readonly device: AuthDeviceContext;
	readonly deviceHash: string;
	readonly requestIpHash: string;
	readonly hashKeyVersion: string;
	readonly refreshTokenHash: VersionedHash;
	readonly accessTokenHash: VersionedHash;
	readonly issuedAt: Date;
	readonly refreshExpiresAt: Date;
	readonly sessionRetainUntil: Date;
	readonly accessExpiresAt: Date;
	readonly accessRetainUntil: Date;
}

export interface RefreshIssueDraft {
	readonly refreshCredentialId: string;
	readonly accessCredentialId: string;
	readonly refreshTokenHash: VersionedHash;
	readonly accessTokenHash: VersionedHash;
	readonly issuedAt: Date;
	readonly accessExpiresAt: Date;
	readonly accessRetainUntil: Date;
}

export type CompleteCredentialResult =
	| {
			readonly kind: "SUCCESS";
			readonly userId: string;
			readonly sessionId: string;
	  }
	| { readonly kind: "INVALID_CREDENTIALS" }
	| { readonly kind: "IDENTITY_CONFLICT" };

export type RefreshSessionResult =
	| {
			readonly kind: "SUCCESS";
			readonly userId: string;
			readonly sessionId: string;
			readonly accessExpiresAt: Date;
			readonly refreshExpiresAt: Date;
	  }
	| { readonly kind: "INVALID" }
	| { readonly kind: "REPLAY" };

export interface VerifiedOAuthHashes {
	readonly lookup: VersionedHash;
	readonly dedup: VersionedHash;
}
