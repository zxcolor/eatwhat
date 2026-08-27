import { randomUUID } from "node:crypto";
import type {
	AccountExportRequest,
	AccountExportResponse,
	AccountExportStatusResponse,
	AuthDeviceContext,
	AuthTokenResponse,
	BindIdentityRequest,
	BindIdentityResponse,
	DeleteAccountRequest,
	DeleteAccountResponse,
	EmailCodeChallengeResponse,
	EmailRequestCode,
	FusionAuthTokenRequest,
	FusionAuthTokenResponse,
	FusionAuthVerifyRequest,
	FusionAuthVerifyResponse,
	IdentityBinding,
	IdentityBindingsResponse,
	LatestAccountExportResponse,
	LoginRequest,
	LogoutResponse,
	OAuthStateRequest,
	OAuthStateResponse,
	PhoneCodeChallengeResponse,
	PhoneRequestCode,
	RefreshRequest,
	RegisterPhoneWechatRequest,
	RegisterFusionWechatRequest,
	RevokeSessionResponse,
	SessionsResponse,
	UnbindIdentityResponse,
} from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import {
	AuthRepository,
	type CompleteBindingResult,
	type DataExportRecord,
	type IdentityBindingRecord,
} from "./auth.repository.js";
import {
	type AuthSecretKeyRing,
	generateOAuthState,
	generateSixDigitOtp,
	hashAccountDeletionSubject,
	hashIdentityLookup,
	hashOpaqueToken,
	hashOtpCode,
	hashSensitiveRateLimitValue,
	type IssuedOpaqueToken,
	issueOpaqueToken,
	type VersionedHash,
	verifyOtpCode,
} from "./auth-crypto.js";
import {
	AccountExportExpiredException,
	AccountExportNotFoundException,
	AccountExportNotReadyException,
	AuthConflictException,
	AuthForbiddenException,
	AuthInvalidRequestException,
	AuthRateLimitedException,
	AuthUnauthorizedException,
	AuthUnavailableException,
} from "./auth-errors.js";
import {
	EMAIL_OTP_PROVIDER,
	FUSION_AUTH_PROVIDER,
	PHONE_OTP_PROVIDER,
	QQ_IDENTITY_PROVIDER,
	WECHAT_IDENTITY_PROVIDER,
} from "./auth-provider.factories.js";
import type {
	OAuthProof,
	OtpProof,
	SessionIssueDraft,
	VerifiedFusionPhoneHashes,
	VerifiedOAuthHashes,
} from "./auth-workflow.types.js";
import {
	AUTHENTICATED_USER_RESOLVER,
	type AuthenticatedUserContext,
	type AuthenticatedUserResolver,
} from "./authenticated-user.resolver.js";
import {
	EXPORT_ARTIFACT_READER,
	type ExportArtifactReader,
} from "./data-export-artifact.reader.js";
import {
	ExternalIdentityUnavailableError,
	type QqIdentityProvider,
	type VerifiedExternalIdentity,
	type WechatIdentityProvider,
} from "./providers/external-identity.provider.js";
import {
	type OtpDeliveryProvider,
	OtpDeliveryUnavailableError,
} from "./providers/otp-delivery.provider.js";
import {
	type FusionAuthProvider,
	FusionAuthUnavailableError,
} from "./providers/fusion-auth.provider.js";

interface ReadyAuthSecrets {
	readonly hashKeyRing: AuthSecretKeyRing;
	readonly otpPepperRing: AuthSecretKeyRing | null;
	readonly identityDedupKeyVersion: string;
}

interface CommonCodeChallenge {
	readonly challengeId: string;
	readonly maskedTarget: string;
	readonly expiresAt: string;
	readonly resendAvailableAt: string;
}

export interface AccountExportContent {
	readonly body: Awaited<ReturnType<ExportArtifactReader["open"]>>["body"];
	readonly sizeBytes: number;
	readonly sha256: string;
	readonly contentType: "application/json";
}

const MAX_ACCOUNT_EXPORT_BYTES = 10_485_760;

@Injectable()
export class AuthService {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly repository: AuthRepository,
		@Inject(PHONE_OTP_PROVIDER)
		private readonly phoneOtpProvider: OtpDeliveryProvider,
		@Inject(EMAIL_OTP_PROVIDER)
		private readonly emailOtpProvider: OtpDeliveryProvider,
		@Inject(FUSION_AUTH_PROVIDER)
		private readonly fusionAuthProvider: FusionAuthProvider,
		@Inject(WECHAT_IDENTITY_PROVIDER)
		private readonly wechatIdentityProvider: WechatIdentityProvider,
		@Inject(QQ_IDENTITY_PROVIDER)
		private readonly qqIdentityProvider: QqIdentityProvider,
		@Inject(AUTHENTICATED_USER_RESOLVER)
		private readonly authenticatedUserResolver: AuthenticatedUserResolver,
		@Inject(EXPORT_ARTIFACT_READER)
		private readonly exportArtifactReader: ExportArtifactReader,
	) {}

	async requestPhoneCode(
		input: PhoneRequestCode,
		bearer: string | null,
		clientIp: string,
	): Promise<PhoneCodeChallengeResponse> {
		if (input.purpose === "REGISTER") {
			this.requireRegistrationEnabled("PHONE");
		} else if (!this.config.auth.phone.enabled) {
			throw new AuthUnavailableException();
		}
		const challenge = await this.requestCode(
			"PHONE",
			input.phoneNumber,
			input.purpose,
			input.installationId,
			bearer,
			clientIp,
		);
		return Object.freeze({ ...challenge, targetType: "PHONE" as const });
	}

	async requestEmailCode(
		input: EmailRequestCode,
		bearer: string | null,
		clientIp: string,
	): Promise<EmailCodeChallengeResponse> {
		if (!this.config.auth.email.enabled) {
			throw new AuthUnavailableException();
		}
		const challenge = await this.requestCode(
			"EMAIL",
			normalizeEmail(input.email),
			input.purpose,
			input.installationId,
			bearer,
			clientIp,
		);
		return Object.freeze({ ...challenge, targetType: "EMAIL" as const });
	}

	async requestFusionToken(
		input: FusionAuthTokenRequest,
		clientIp: string,
	): Promise<FusionAuthTokenResponse> {
		// REGISTER identifies a standalone phone-proof flow; it does not authorize
		// account creation. The final registration and REGISTER OAuth paths enforce
		// registrationEnabled before any provider or repository side effect.
		const secrets = this.readySecrets();
		const fusion = this.config.auth.fusion;
		if (!fusion.enabled || fusion.schemeCode === null) {
			throw new AuthUnavailableException();
		}
		let authToken: string;
		try {
			authToken = (await this.fusionAuthProvider.issueToken()).authToken;
		} catch {
			throw new AuthUnavailableException();
		}
		const createdAt = new Date();
		const expiresAt = new Date(createdAt.getTime() + fusion.tokenTtlMs);
		const hashKeyVersion = secrets.hashKeyRing.activeVersion;
		const flowId = randomUUID();
		const created = await this.repositoryCall(() =>
			this.repository.createFusionFlow({
				id: flowId,
				purpose: input.purpose,
				registrationFlowReferenceHash:
					input.purpose === "REGISTER"
						? hashSensitiveRateLimitValue(
								"flow-reference",
								generateOAuthState(),
								secrets.hashKeyRing,
								hashKeyVersion,
							).value
						: null,
				requestIpHash: hashSensitiveRateLimitValue(
					"ip",
					clientIp,
					secrets.hashKeyRing,
					hashKeyVersion,
				).value,
				deviceHash: hashSensitiveRateLimitValue(
					"device",
					input.installationId,
					secrets.hashKeyRing,
					hashKeyVersion,
				).value,
				hashKeyVersion,
				createdAt,
				expiresAt,
				retainUntil: new Date(createdAt.getTime() + 24 * 60 * 60_000),
			}),
		);
		if (!created) throw new AuthUnavailableException();
		return Object.freeze({
			flowId,
			schemeCode: fusion.schemeCode,
			authToken,
			expiresAt: expiresAt.toISOString(),
		});
	}

	async verifyFusionPhone(
		input: FusionAuthVerifyRequest,
	): Promise<FusionAuthVerifyResponse> {
		const secrets = this.readySecrets();
		if (!this.config.auth.fusion.enabled) {
			throw new AuthUnavailableException();
		}
		const proof = await this.repositoryCall(() =>
			this.repository.findFusionProof(
				input.flowId,
				"REGISTER",
				deviceHashValues(input.installationId, secrets.hashKeyRing),
			),
		);
		if (proof === null) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		const verifiedPhone = await this.verifyFusionToken(
			input.verifyToken,
			proof.hashKeyVersion,
			secrets,
			async (verifyTokenHashes, primaryVerifyTokenHash) =>
				this.repositoryCall(() =>
					this.repository.claimFusionVerifyToken(
						proof,
						verifyTokenHashes,
						primaryVerifyTokenHash,
					),
				),
			async (verifyTokenHash) => {
				await this.repositoryCall(() =>
					this.repository.completeFusionVerification({
						proof,
						verifyTokenHash,
						verifiedPhone: null,
					}),
				);
			},
		);
		const result = await this.repositoryCall(() =>
			this.repository.completeFusionVerification({
				proof,
				verifyTokenHash: verifiedPhone.verifyTokenHash,
				verifiedPhone,
			}),
		);
		if (result.kind !== "SUCCESS") {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		return Object.freeze({
			proofId: result.proof.id,
			expiresAt: result.proof.expiresAt.toISOString(),
		});
	}

	async createOAuthState(
		input: OAuthStateRequest,
		bearer: string | null,
		clientIp: string,
	): Promise<OAuthStateResponse> {
		if (
			(input.provider === "WECHAT" && !this.config.auth.wechat.enabled) ||
			(input.provider === "QQ" && !this.config.auth.qq.enabled)
		) {
			throw new AuthUnavailableException();
		}
		if (input.purpose === "REGISTER") {
			this.requireRegistrationEnabled(
				"phoneProofId" in input ? "FUSION" : "PHONE",
			);
		}
		const secrets = this.readySecrets();
		const deviceCandidates = hashCandidates(
			"device",
			input.installationId,
			secrets.hashKeyRing,
		).map((candidate) => candidate.value);

		let hashKeyVersion = secrets.hashKeyRing.activeVersion;
		let flowReferenceHash: string;
		let deviceHash: string;
		let targetUserId: string | null = null;
		let operationTargetHash: string | null = null;
		if (input.purpose === "REGISTER") {
			const flow =
				"phoneProofId" in input
					? await this.repositoryCall(() =>
							this.repository.findVerifiedFusionProof(
								input.phoneProofId,
								deviceCandidates,
							),
						)
					: await this.repositoryCall(() =>
							this.repository.findRegistrationFlow(
								input.phoneChallengeId,
								deviceCandidates,
							),
						);
			if (flow === null)
				throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
			hashKeyVersion = flow.hashKeyVersion;
			flowReferenceHash = flow.registrationFlowReferenceHash;
			deviceHash = flow.deviceHash;
		} else if (input.purpose === "BIND") {
			if (bearer === null) throw new AuthUnauthorizedException();
			const session = await this.authenticatedUserResolver.resolveAccessToken(
				bearer,
				input.installationId,
			);
			deviceHash = session.deviceHash;
			targetUserId = session.userId;
			flowReferenceHash = hashSensitiveRateLimitValue(
				"flow-reference",
				session.sessionId,
				secrets.hashKeyRing,
				hashKeyVersion,
			).value;
			operationTargetHash = hashSensitiveRateLimitValue(
				"flow-reference",
				generateOAuthState(),
				secrets.hashKeyRing,
				hashKeyVersion,
			).value;
		} else {
			const selectedDeviceHash = hashSensitiveRateLimitValue(
				"device",
				input.installationId,
				secrets.hashKeyRing,
				hashKeyVersion,
			);
			deviceHash = selectedDeviceHash.value;
			flowReferenceHash = hashSensitiveRateLimitValue(
				"ip",
				clientIp,
				secrets.hashKeyRing,
				hashKeyVersion,
			).value;
		}

		const state = generateOAuthState();
		const stateHash = hashSensitiveRateLimitValue(
			"oauth-state",
			state,
			secrets.hashKeyRing,
			hashKeyVersion,
		);
		const createdAt = new Date();
		const expiresAt = new Date(
			createdAt.getTime() + this.config.auth.oauthStateTtlMs,
		);
		const created = await this.repositoryCall(() =>
			this.repository.createOAuthState({
				id: randomUUID(),
				provider: input.provider,
				purpose: input.purpose,
				stateHash,
				flowReferenceHash,
				operationTargetHash,
				targetUserId,
				deviceHash,
				createdAt,
				expiresAt,
				retainUntil: new Date(createdAt.getTime() + 24 * 60 * 60_000),
			}),
		);
		if (created.kind === "RATE_LIMITED") {
			throw new AuthRateLimitedException(created.retryAfterSeconds);
		}
		return Object.freeze({
			provider: input.provider,
			purpose: input.purpose,
			state,
			expiresAt: expiresAt.toISOString(),
		}) as OAuthStateResponse;
	}

	async register(
		input: RegisterPhoneWechatRequest,
		clientIp: string,
	): Promise<AuthTokenResponse> {
		this.requireRegistrationEnabled("PHONE");
		const secrets = this.readySecrets();
		assertDeviceLabel(input.device.label);
		const deviceCandidates = deviceHashValues(
			input.device.installationId,
			secrets.hashKeyRing,
		);
		const otpProof = await this.repositoryCall(() =>
			this.repository.findOtpProof(
				input.phoneChallengeId,
				"PHONE",
				"REGISTER",
				deviceCandidates,
			),
		);
		const oauthProof = await this.repositoryCall(() =>
			this.repository.findOAuthProof(
				hashCandidates(
					"oauth-state",
					input.wechatOAuthState,
					secrets.hashKeyRing,
				),
				"WECHAT",
				"REGISTER",
				deviceCandidates,
			),
		);
		if (
			otpProof === null ||
			oauthProof === null ||
			otpProof.registrationFlowReferenceHash === null ||
			otpProof.registrationFlowReferenceHash !== oauthProof.flowReferenceHash ||
			otpProof.deviceHash !== oauthProof.deviceHash
		) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}

		const otpValid = await verifyOtpCode(
			input.phoneOtpCode,
			otpProof.codeHash,
			otpProof.codeHashKeyVersion,
			this.readyOtpPepper(secrets),
		);
		if (!otpValid) {
			await this.repositoryCall(() =>
				this.repository.completeRegistration({
					newUserId: randomUUID(),
					otpProof,
					otpVerificationSucceeded: false,
					oauthProof,
					verifiedWechatIdentity: null,
					session: null,
				}),
			);
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}

		const verified = await this.verifyWechat(input.wechatAuthorizationCode);
		const verifiedHashes = this.identityHashes(verified, secrets);
		const issued = this.issueSession(
			input.device,
			clientIp,
			otpProof.hashKeyVersion,
			secrets.hashKeyRing,
			otpProof.deviceHash,
		);
		const result = await this.repositoryCall(() =>
			this.repository.completeRegistration({
				newUserId: randomUUID(),
				otpProof,
				otpVerificationSucceeded: true,
				oauthProof,
				verifiedWechatIdentity: verifiedHashes,
				session: issued.draft,
			}),
		);
		return this.tokenResponse(result, issued);
	}

	async registerWithFusion(
		input: RegisterFusionWechatRequest,
		clientIp: string,
	): Promise<AuthTokenResponse> {
		this.requireRegistrationEnabled("FUSION");
		const secrets = this.readySecrets();
		assertDeviceLabel(input.device.label);
		const deviceCandidates = deviceHashValues(
			input.device.installationId,
			secrets.hashKeyRing,
		);
		const phoneProof = await this.repositoryCall(() =>
			this.repository.findVerifiedFusionProof(
				input.phoneProofId,
				deviceCandidates,
			),
		);
		const oauthProof = await this.repositoryCall(() =>
			this.repository.findOAuthProof(
				hashCandidates(
					"oauth-state",
					input.wechatOAuthState,
					secrets.hashKeyRing,
				),
				"WECHAT",
				"REGISTER",
				deviceCandidates,
			),
		);
		if (
			phoneProof === null ||
			oauthProof === null ||
			phoneProof.registrationFlowReferenceHash !==
				oauthProof.flowReferenceHash ||
			phoneProof.deviceHash !== oauthProof.deviceHash
		) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		const verified = await this.verifyWechat(input.wechatAuthorizationCode);
		const issued = this.issueSession(
			input.device,
			clientIp,
			phoneProof.hashKeyVersion,
			secrets.hashKeyRing,
			phoneProof.deviceHash,
		);
		const result = await this.repositoryCall(() =>
			this.repository.completeFusionRegistration({
				newUserId: randomUUID(),
				phoneProof,
				oauthProof,
				verifiedWechatIdentity: this.identityHashes(verified, secrets),
				session: issued.draft,
			}),
		);
		return this.tokenResponse(result, issued);
	}

	async login(
		input: LoginRequest,
		clientIp: string,
	): Promise<AuthTokenResponse> {
		this.requireLoginChannelEnabled(input.method);
		const secrets = this.readySecrets();
		assertDeviceLabel(input.device.label);
		if (input.method === "PHONE" || input.method === "EMAIL") {
			return this.loginWithOtp(input, clientIp, secrets);
		}
		if (input.method === "PHONE_FUSION") {
			return this.loginWithFusion(input, clientIp, secrets);
		}
		return this.loginWithOAuth(input, clientIp, secrets);
	}

	async refresh(
		input: RefreshRequest,
		clientIp: string,
	): Promise<AuthTokenResponse> {
		const secrets = this.readySecrets();
		void clientIp;
		const access = issueOpaqueToken(secrets.hashKeyRing, "access-token");
		const refresh = issueOpaqueToken(secrets.hashKeyRing, "refresh-token");
		const issuedAt = new Date();
		const result = await this.repositoryCall(() =>
			this.repository.refreshSession(
				tokenHashCandidates(
					input.refreshToken,
					"refresh-token",
					secrets.hashKeyRing,
				),
				deviceHashValues(input.installationId, secrets.hashKeyRing),
				{
					refreshCredentialId: randomUUID(),
					accessCredentialId: randomUUID(),
					refreshTokenHash: refresh.hash,
					accessTokenHash: access.hash,
					issuedAt,
					accessExpiresAt: new Date(
						issuedAt.getTime() + this.config.auth.accessTokenTtlMs,
					),
					accessRetainUntil: new Date(
						issuedAt.getTime() +
							this.config.auth.accessTokenTtlMs +
							24 * 60 * 60_000,
					),
				},
			),
		);
		if (result.kind === "REPLAY") {
			throw new AuthUnauthorizedException("TOKEN_REPLAY_DETECTED");
		}
		if (result.kind === "INVALID") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		return Object.freeze({
			userId: result.userId,
			sessionId: result.sessionId,
			tokenType: "Bearer" as const,
			accessToken: access.token,
			accessTokenExpiresAt: result.accessExpiresAt.toISOString(),
			refreshToken: refresh.token,
			refreshTokenExpiresAt: result.refreshExpiresAt.toISOString(),
		});
	}

	async logout(bearer: string): Promise<LogoutResponse> {
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const result = await this.repositoryCall(() =>
			this.repository.revokeSession(session, session.sessionId),
		);
		if (result.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		if (result.kind === "CONFLICT") {
			throw new AuthConflictException("SESSION_CONFLICT");
		}
		return Object.freeze({
			sessionId: session.sessionId,
			loggedOutAt: result.revokedAt.toISOString(),
		});
	}
	async listIdentities(bearer: string): Promise<IdentityBindingsResponse> {
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const bindings = await this.repositoryCall(() =>
			this.repository.listIdentityBindings(session),
		);
		if (bindings === null) {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		return Object.freeze({
			items: bindings.map((binding) => this.publicIdentityBinding(binding)),
		});
	}
	async bindIdentity(
		bearer: string,
		input: BindIdentityRequest,
	): Promise<BindIdentityResponse> {
		if (
			(input.type === "EMAIL" && !this.config.auth.email.enabled) ||
			(input.type === "QQ" && !this.config.auth.qq.enabled)
		) {
			throw new AuthUnavailableException();
		}
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const secrets = this.readySecrets();
		if (input.type === "EMAIL") {
			const proof = await this.repositoryCall(() =>
				this.repository.findOtpProof(input.challengeId, "EMAIL", "BIND", [
					session.deviceHash,
				]),
			);
			if (!this.bindingProofMatchesSession(proof, session)) {
				throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
			}
			const valid = await verifyOtpCode(
				input.otpCode,
				proof.codeHash,
				proof.codeHashKeyVersion,
				this.readyOtpPepper(secrets),
			);
			const result = await this.repositoryCall(() =>
				this.repository.completeOtpBinding({
					session,
					proof,
					verificationSucceeded: valid,
				}),
			);
			return this.bindingResponse(result);
		}

		const proof = await this.repositoryCall(() =>
			this.repository.findOAuthProof(
				hashCandidates("oauth-state", input.oauthState, secrets.hashKeyRing),
				"QQ",
				"BIND",
				[session.deviceHash],
			),
		);
		if (!this.bindingProofMatchesSession(proof, session)) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		const verified = await this.verifyQq(input.accessToken);
		const result = await this.repositoryCall(() =>
			this.repository.completeOAuthBinding({
				session,
				proof,
				verifiedIdentity: this.identityHashes(verified, secrets),
			}),
		);
		return this.bindingResponse(result);
	}
	async unbindIdentity(
		bearer: string,
		bindingId: string,
	): Promise<UnbindIdentityResponse> {
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const result = await this.repositoryCall(() =>
			this.repository.unbindIdentity(session, bindingId),
		);
		if (result.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		if (result.kind === "FORBIDDEN") throw new AuthForbiddenException();
		if (result.kind === "CONFLICT") {
			throw new AuthConflictException("IDENTITY_BINDING_CONFLICT");
		}
		return Object.freeze({
			bindingId,
			unboundAt: result.unboundAt.toISOString(),
		});
	}
	async listSessions(bearer: string): Promise<SessionsResponse> {
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const sessions = await this.repositoryCall(() =>
			this.repository.listSessions(session),
		);
		if (sessions === null) {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		return Object.freeze({
			items: sessions.map((item) =>
				Object.freeze({
					sessionId: item.sessionId,
					deviceLabel: item.deviceLabel,
					platform: item.platform,
					current: item.current,
					createdAt: item.createdAt.toISOString(),
					lastActiveAt: item.lastActiveAt.toISOString(),
					expiresAt: item.expiresAt.toISOString(),
				}),
			),
		});
	}
	async revokeSession(
		bearer: string,
		sessionId: string,
	): Promise<RevokeSessionResponse> {
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const result = await this.repositoryCall(() =>
			this.repository.revokeSession(session, sessionId),
		);
		if (result.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		if (result.kind === "CONFLICT") {
			throw new AuthConflictException("SESSION_CONFLICT");
		}
		return Object.freeze({
			sessionId,
			revokedAt: result.revokedAt.toISOString(),
		});
	}
	async requestExport(
		bearer: string,
		input: AccountExportRequest,
	): Promise<AccountExportResponse> {
		this.requireDataExportEnabled();
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const result = await this.repositoryCall(() =>
			this.repository.queueDataExport(session, {
				exportId: randomUUID(),
				includeBehaviorHistory: input.includeBehaviorHistory,
			}),
		);
		if (result.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		if (result.kind === "CONFLICT") {
			throw new AuthConflictException("SESSION_CONFLICT");
		}
		return Object.freeze({
			exportId: result.exportId,
			status: "QUEUED" as const,
			requestedAt: result.requestedAt.toISOString(),
			expiresAt: result.expiresAt.toISOString(),
			includeBehaviorHistory: result.includeBehaviorHistory,
		});
	}

	async getExport(
		bearer: string,
		exportId: string,
	): Promise<AccountExportStatusResponse> {
		this.requireDataExportEnabled();
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const result = await this.repositoryCall(() =>
			this.repository.readDataExport(session, exportId),
		);
		if (result.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		if (result.kind === "NOT_FOUND") {
			throw new AccountExportNotFoundException();
		}
		return this.toExportStatusResponse(result.record);
	}

	async getLatestExport(bearer: string): Promise<LatestAccountExportResponse> {
		this.requireDataExportEnabled();
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const result = await this.repositoryCall(() =>
			this.repository.readLatestDataExport(session),
		);
		if (result.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		return Object.freeze({
			item:
				result.record === null
					? null
					: this.toExportStatusResponse(result.record),
		});
	}

	async openExportContent(
		bearer: string,
		exportId: string,
	): Promise<AccountExportContent> {
		this.requireDataExportEnabled();
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const statusResult = await this.repositoryCall(() =>
			this.repository.readDataExport(session, exportId),
		);
		if (statusResult.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		if (statusResult.kind === "NOT_FOUND") {
			throw new AccountExportNotFoundException();
		}
		if (statusResult.record.status === "EXPIRED") {
			throw new AccountExportExpiredException();
		}
		if (statusResult.record.status !== "READY") {
			throw new AccountExportNotReadyException();
		}
		if (statusResult.record.expiresAt.getTime() <= Date.now()) {
			throw new AccountExportExpiredException();
		}
		if (statusResult.record.artifactSizeBytes > MAX_ACCOUNT_EXPORT_BYTES) {
			throw new AuthUnavailableException();
		}

		const opened = await this.repositoryCall(() =>
			this.repository.openDataExportArtifact(session, exportId),
		);
		if (opened.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		if (opened.kind === "NOT_AVAILABLE") {
			return await this.throwCurrentExportAvailability(session, exportId);
		}
		const artifact = opened.artifact;
		try {
			if (
				artifact.sizeBytes !== statusResult.record.artifactSizeBytes ||
				artifact.sha256 !== statusResult.record.artifactSha256 ||
				artifact.contentType !== "application/json" ||
				artifact.sizeBytes > MAX_ACCOUNT_EXPORT_BYTES
			) {
				throw new AuthUnavailableException();
			}

			let body: AccountExportContent["body"];
			try {
				body = (
					await this.exportArtifactReader.open({
						locatorCiphertext: artifact.locatorCiphertext,
						locatorKeyVersion: artifact.locatorKeyVersion,
						expectedSizeBytes: artifact.sizeBytes,
						expectedSha256: artifact.sha256,
					})
				).body;
			} catch {
				throw new AuthUnavailableException();
			}
			return Object.freeze({
				body,
				sizeBytes: artifact.sizeBytes,
				sha256: artifact.sha256,
				contentType: "application/json" as const,
			});
		} finally {
			artifact.locatorCiphertext.fill(0);
		}
	}
	async deleteAccount(
		bearer: string,
		input: DeleteAccountRequest,
	): Promise<DeleteAccountResponse> {
		void input;
		const secrets = this.readySecrets();
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const deletionId = randomUUID();
		const result = await this.repositoryCall(() =>
			this.repository.beginAccountDeletion(session, {
				deletionId,
				subjectHash: hashAccountDeletionSubject(
					session.userId,
					secrets.hashKeyRing,
				),
				purgeDueAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
			}),
		);
		if (result.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		if (result.kind === "CONFLICT") {
			throw new AuthConflictException("ACCOUNT_DELETION_PENDING");
		}
		return Object.freeze({
			deletionId,
			userId: session.userId,
			status: "DEACTIVATED" as const,
			invalidatedAt: result.requestedAt.toISOString(),
			backupDeletionDeadline: result.purgeDueAt.toISOString(),
		});
	}

	private toExportStatusResponse(
		record: DataExportRecord,
	): AccountExportStatusResponse {
		const common = {
			exportId: record.exportId,
			requestedAt: record.requestedAt.toISOString(),
			expiresAt: record.expiresAt.toISOString(),
			includeBehaviorHistory: record.includeBehaviorHistory,
		};
		if (record.status === "QUEUED" || record.status === "PROCESSING") {
			return Object.freeze({
				...common,
				status: record.status,
				downloadAvailable: false as const,
			});
		}
		if (record.status === "READY") {
			if (record.artifactSizeBytes > MAX_ACCOUNT_EXPORT_BYTES) {
				throw new AuthUnavailableException();
			}
			return Object.freeze({
				...common,
				status: "READY" as const,
				readyAt: record.readyAt.toISOString(),
				sizeBytes: record.artifactSizeBytes,
				sha256: record.artifactSha256,
				contentType: "application/json" as const,
				downloadAvailable: true as const,
			});
		}
		if (record.status === "FAILED") {
			return Object.freeze({
				...common,
				status: "FAILED" as const,
				failureCode: "GENERATION_FAILED" as const,
				downloadAvailable: false as const,
			});
		}
		return Object.freeze({
			...common,
			status: "EXPIRED" as const,
			downloadAvailable: false as const,
		});
	}

	private requireDataExportEnabled(): void {
		if (
			!this.config.auth.dataExportEnabled ||
			this.config.dataExportWorkerReady !== true
		) {
			throw new AuthUnavailableException();
		}
	}

	private requireRegistrationEnabled(channel: "PHONE" | "FUSION"): void {
		const mobileEnabled =
			channel === "PHONE"
				? this.config.auth.phone.enabled
				: this.config.auth.fusion.enabled;
		if (
			!this.config.auth.registrationEnabled ||
			!mobileEnabled ||
			!this.config.auth.wechat.enabled
		) {
			throw new AuthUnavailableException();
		}
	}

	private requireLoginChannelEnabled(method: LoginRequest["method"]): void {
		const enabled =
			method === "PHONE"
				? this.config.auth.phone.enabled
				: method === "PHONE_FUSION"
					? this.config.auth.fusion.enabled
					: method === "EMAIL"
						? this.config.auth.email.enabled
						: method === "WECHAT"
							? this.config.auth.wechat.enabled
							: this.config.auth.qq.enabled;
		if (!enabled) {
			throw new AuthUnavailableException();
		}
	}

	private async throwCurrentExportAvailability(
		session: AuthenticatedUserContext,
		exportId: string,
	): Promise<never> {
		const refreshed = await this.repositoryCall(() =>
			this.repository.readDataExport(session, exportId),
		);
		if (refreshed.kind === "INVALID_CREDENTIALS") {
			throw new AuthUnauthorizedException("SESSION_EXPIRED");
		}
		if (refreshed.kind === "NOT_FOUND") {
			throw new AccountExportNotFoundException();
		}
		if (
			refreshed.record.status === "EXPIRED" ||
			refreshed.record.expiresAt.getTime() <= Date.now()
		) {
			throw new AccountExportExpiredException();
		}
		if (refreshed.record.status !== "READY") {
			throw new AccountExportNotReadyException();
		}
		throw new AuthUnavailableException();
	}

	private async requestCode(
		channel: "PHONE" | "EMAIL",
		destination: string,
		purpose: "REGISTER" | "LOGIN" | "BIND",
		installationId: string,
		bearer: string | null,
		clientIp: string,
	): Promise<CommonCodeChallenge> {
		const secrets = this.readySecrets();
		const provider =
			channel === "PHONE" ? this.phoneOtpProvider : this.emailOtpProvider;
		const hashVersion = secrets.hashKeyRing.activeVersion;
		let deviceHash = hashSensitiveRateLimitValue(
			"device",
			installationId,
			secrets.hashKeyRing,
			hashVersion,
		).value;
		let targetUserId: string | null = null;
		let operationTargetHash: string | null = null;
		if (purpose === "BIND") {
			const session = await this.requireAccess(bearer, installationId);
			targetUserId = session.userId;
			deviceHash = session.deviceHash;
			operationTargetHash = hashSensitiveRateLimitValue(
				"flow-reference",
				generateOAuthState(),
				secrets.hashKeyRing,
				hashVersion,
			).value;
		}

		const code = generateSixDigitOtp();
		const idempotencyKey = generateOAuthState();
		const codeHash = await hashOtpCode(code, this.readyOtpPepper(secrets));
		const createdAt = new Date();
		const expiresAt = new Date(createdAt.getTime() + this.config.auth.otpTtlMs);
		const resendAvailableAt = new Date(
			createdAt.getTime() + this.config.auth.otpResendDelayMs,
		);
		const destinationScope = channel === "PHONE" ? "e164" : "email-lowercase";
		const draft = Object.freeze({
			id: randomUUID(),
			channel,
			purpose,
			destinationLookup: hashIdentityLookup(
				channel,
				destinationScope,
				destination,
				secrets.hashKeyRing,
				hashVersion,
			),
			destinationDedup: hashIdentityLookup(
				channel,
				destinationScope,
				destination,
				secrets.hashKeyRing,
				secrets.identityDedupKeyVersion,
			),
			maskedDestination:
				channel === "PHONE" ? maskPhone(destination) : maskEmail(destination),
			operationTargetHash,
			targetUserId,
			registrationFlowReferenceHash:
				purpose === "REGISTER"
					? hashSensitiveRateLimitValue(
							"flow-reference",
							generateOAuthState(),
							secrets.hashKeyRing,
							hashVersion,
						).value
					: null,
			codeHash,
			idempotencyKeyHash: hashSensitiveRateLimitValue(
				"idempotency",
				idempotencyKey,
				secrets.hashKeyRing,
				hashVersion,
			).value,
			hashKeyVersion: hashVersion,
			requestIpHash: hashSensitiveRateLimitValue(
				"ip",
				clientIp,
				secrets.hashKeyRing,
				hashVersion,
			).value,
			deviceHash,
			createdAt,
			retainUntil: new Date(createdAt.getTime() + 24 * 60 * 60_000),
			expiresAt,
			resendAvailableAt,
		});
		const created = await this.repositoryCall(() =>
			this.repository.createOtpChallenge(draft),
		);
		if (created.kind === "RATE_LIMITED") {
			throw new AuthRateLimitedException(created.retryAfterSeconds);
		}
		if (created.kind === "EXISTING") {
			return Object.freeze({
				challengeId: created.challengeId,
				maskedTarget: created.maskedDestination,
				expiresAt: created.expiresAt.toISOString(),
				resendAvailableAt: created.resendAvailableAt.toISOString(),
			});
		}

		try {
			const receipt = await provider.send({
				channel,
				destination,
				code,
				idempotencyKey,
				expiresAt,
			});
			const referenceHash = hashSensitiveRateLimitValue(
				"idempotency",
				`${receipt.provider}\u0000${receipt.requestReference}`,
				secrets.hashKeyRing,
				hashVersion,
			).value;
			const finalized = await this.repositoryCall(() =>
				this.repository.finalizeOtpDelivery(
					draft.id,
					"SENT",
					referenceHash,
					expiresAt,
				),
			);
			if (!finalized) throw new AuthUnavailableException();
		} catch (error) {
			if (!(error instanceof AuthUnavailableException)) {
				await this.repositoryCall(() =>
					this.repository.finalizeOtpDelivery(draft.id, "FAILED", null, null),
				).catch(() => undefined);
			}
			if (
				error instanceof OtpDeliveryUnavailableError ||
				error instanceof AuthUnavailableException
			) {
				throw new AuthUnavailableException();
			}
			throw new AuthUnavailableException();
		}
		return Object.freeze({
			challengeId: draft.id,
			maskedTarget: draft.maskedDestination,
			expiresAt: expiresAt.toISOString(),
			resendAvailableAt: resendAvailableAt.toISOString(),
		});
	}

	private async loginWithOtp(
		input: Extract<LoginRequest, { method: "PHONE" | "EMAIL" }>,
		clientIp: string,
		secrets: ReadyAuthSecrets,
	): Promise<AuthTokenResponse> {
		const proof = await this.repositoryCall(() =>
			this.repository.findOtpProof(
				input.challengeId,
				input.method,
				"LOGIN",
				deviceHashValues(input.device.installationId, secrets.hashKeyRing),
			),
		);
		if (proof === null)
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		const valid = await verifyOtpCode(
			input.otpCode,
			proof.codeHash,
			proof.codeHashKeyVersion,
			this.readyOtpPepper(secrets),
		);
		const issued = valid
			? this.issueSession(
					input.device,
					clientIp,
					proof.hashKeyVersion,
					secrets.hashKeyRing,
					proof.deviceHash,
				)
			: null;
		const result = await this.repositoryCall(() =>
			this.repository.completeOtpLogin({
				proof,
				verificationSucceeded: valid,
				session: issued?.draft ?? null,
			}),
		);
		if (issued === null)
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		return this.tokenResponse(result, issued);
	}

	private async loginWithFusion(
		input: Extract<LoginRequest, { method: "PHONE_FUSION" }>,
		clientIp: string,
		secrets: ReadyAuthSecrets,
	): Promise<AuthTokenResponse> {
		if (!this.config.auth.fusion.enabled) {
			throw new AuthUnavailableException();
		}
		const proof = await this.repositoryCall(() =>
			this.repository.findFusionProof(
				input.flowId,
				"LOGIN",
				deviceHashValues(input.device.installationId, secrets.hashKeyRing),
			),
		);
		if (proof === null) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		const verifiedPhone = await this.verifyFusionToken(
			input.verifyToken,
			proof.hashKeyVersion,
			secrets,
			async (verifyTokenHashes, primaryVerifyTokenHash) =>
				this.repositoryCall(() =>
					this.repository.claimFusionVerifyToken(
						proof,
						verifyTokenHashes,
						primaryVerifyTokenHash,
					),
				),
			async (verifyTokenHash) => {
				await this.repositoryCall(() =>
					this.repository.completeFusionLogin({
						proof,
						verifyTokenHash,
						verifiedPhone: null,
						session: null,
					}),
				);
			},
		);
		const issued = this.issueSession(
			input.device,
			clientIp,
			proof.hashKeyVersion,
			secrets.hashKeyRing,
			proof.deviceHash,
		);
		const result = await this.repositoryCall(() =>
			this.repository.completeFusionLogin({
				proof,
				verifyTokenHash: verifiedPhone.verifyTokenHash,
				verifiedPhone,
				session: issued.draft,
			}),
		);
		return this.tokenResponse(result, issued);
	}

	private async loginWithOAuth(
		input: Extract<LoginRequest, { method: "WECHAT" | "QQ" }>,
		clientIp: string,
		secrets: ReadyAuthSecrets,
	): Promise<AuthTokenResponse> {
		const stateHash = hashCandidates(
			"oauth-state",
			input.oauthState,
			secrets.hashKeyRing,
		);
		const proof = await this.repositoryCall(() =>
			this.repository.findOAuthProof(
				stateHash,
				input.method,
				"LOGIN",
				deviceHashValues(input.device.installationId, secrets.hashKeyRing),
			),
		);
		if (proof === null)
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		const verified =
			input.method === "WECHAT"
				? await this.verifyWechat(input.authorizationCode)
				: await this.verifyQq(input.accessToken);
		const issued = this.issueSession(
			input.device,
			clientIp,
			proof.hashKeyVersion,
			secrets.hashKeyRing,
			proof.deviceHash,
		);
		const result = await this.repositoryCall(() =>
			this.repository.completeOAuthLogin({
				proof,
				verifiedIdentity: this.identityHashes(verified, secrets),
				session: issued.draft,
			}),
		);
		return this.tokenResponse(result, issued);
	}

	private async verifyFusionToken(
		verifyToken: string,
		hashKeyVersion: string,
		secrets: ReadyAuthSecrets,
		claimVerifyToken: (
			verifyTokenHashes: readonly VersionedHash[],
			primaryVerifyTokenHash: VersionedHash,
		) => Promise<boolean>,
		recordInvalidAttempt: (verifyTokenHash: VersionedHash) => Promise<void>,
	): Promise<VerifiedFusionPhoneHashes> {
		const verifyTokenHashes = secrets.hashKeyRing.versions().map((version) =>
			hashSensitiveRateLimitValue(
				"fusion-verify-token",
				verifyToken,
				secrets.hashKeyRing,
				version,
			),
		);
		const verifyTokenHash = verifyTokenHashes.find(
			(candidate) => candidate.keyVersion === secrets.identityDedupKeyVersion,
		);
		if (verifyTokenHash === undefined) throw new AuthUnavailableException();
		if (!(await claimVerifyToken(verifyTokenHashes, verifyTokenHash))) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		try {
			const verified = await this.fusionAuthProvider.verifyToken(verifyToken);
			return Object.freeze({
				lookup: hashIdentityLookup(
					"PHONE",
					"e164",
					verified.e164PhoneNumber,
					secrets.hashKeyRing,
					hashKeyVersion,
				),
				dedup: hashIdentityLookup(
					"PHONE",
					"e164",
					verified.e164PhoneNumber,
					secrets.hashKeyRing,
					secrets.identityDedupKeyVersion,
				),
				maskedPhone: maskPhone(verified.e164PhoneNumber),
				verifyTokenHash,
			});
		} catch (error) {
			await recordInvalidAttempt(verifyTokenHash);
			if (
				error instanceof FusionAuthUnavailableError &&
				(error.reason === "INVALID_PROOF" ||
					error.reason === "UPSTREAM_REJECTED")
			) {
				throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
			}
			throw new AuthUnavailableException();
		}
	}

	private issueSession(
		device: AuthDeviceContext,
		clientIp: string,
		hashKeyVersion: string,
		keyRing: AuthSecretKeyRing,
		deviceHash: string,
	): {
		readonly draft: SessionIssueDraft;
		readonly access: IssuedOpaqueToken;
		readonly refresh: IssuedOpaqueToken;
	} {
		const issuedAt = new Date();
		const accessExpiresAt = new Date(
			issuedAt.getTime() + this.config.auth.accessTokenTtlMs,
		);
		const refreshExpiresAt = new Date(
			issuedAt.getTime() + this.config.auth.refreshTokenTtlMs,
		);
		const access = issueOpaqueToken(keyRing, "access-token");
		const refresh = issueOpaqueToken(keyRing, "refresh-token");
		return Object.freeze({
			access,
			refresh,
			draft: Object.freeze({
				sessionId: randomUUID(),
				refreshCredentialId: randomUUID(),
				accessCredentialId: randomUUID(),
				device,
				deviceHash,
				requestIpHash: hashSensitiveRateLimitValue(
					"ip",
					clientIp,
					keyRing,
					hashKeyVersion,
				).value,
				hashKeyVersion,
				refreshTokenHash: refresh.hash,
				accessTokenHash: access.hash,
				issuedAt,
				refreshExpiresAt,
				sessionRetainUntil: new Date(
					refreshExpiresAt.getTime() + 30 * 24 * 60 * 60_000,
				),
				accessExpiresAt,
				accessRetainUntil: new Date(
					accessExpiresAt.getTime() + 24 * 60 * 60_000,
				),
			}),
		});
	}

	private tokenResponse(
		result: Awaited<ReturnType<AuthRepository["completeOtpLogin"]>>,
		issued: {
			readonly draft: SessionIssueDraft;
			readonly access: IssuedOpaqueToken;
			readonly refresh: IssuedOpaqueToken;
		},
	): AuthTokenResponse {
		if (result.kind === "IDENTITY_CONFLICT") {
			throw new AuthConflictException("IDENTITY_BINDING_CONFLICT");
		}
		if (result.kind !== "SUCCESS") {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		return Object.freeze({
			userId: result.userId,
			sessionId: result.sessionId,
			tokenType: "Bearer" as const,
			accessToken: issued.access.token,
			accessTokenExpiresAt: issued.draft.accessExpiresAt.toISOString(),
			refreshToken: issued.refresh.token,
			refreshTokenExpiresAt: issued.draft.refreshExpiresAt.toISOString(),
		});
	}

	private bindingProofMatchesSession<Proof extends OtpProof | OAuthProof>(
		proof: Proof | null,
		session: AuthenticatedUserContext,
	): proof is Proof {
		return (
			proof !== null &&
			proof.purpose === "BIND" &&
			proof.targetUserId === session.userId &&
			proof.operationTargetHash !== null &&
			proof.deviceHash === session.deviceHash
		);
	}

	private bindingResponse(result: CompleteBindingResult): BindIdentityResponse {
		if (result.kind === "IDENTITY_CONFLICT") {
			throw new AuthConflictException("IDENTITY_BINDING_CONFLICT");
		}
		if (result.kind !== "SUCCESS") {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		return Object.freeze({
			binding: this.publicIdentityBinding(result.binding),
		});
	}

	private publicIdentityBinding(
		binding: IdentityBindingRecord,
	): IdentityBinding {
		const common = {
			bindingId: binding.bindingId,
			boundAt: binding.boundAt.toISOString(),
			primary: binding.primary,
			canUnbind: binding.canUnbind,
		};
		switch (binding.type) {
			case "PHONE":
				return Object.freeze({
					...common,
					type: "PHONE" as const,
					maskedValue: binding.maskedValue,
				});
			case "EMAIL":
				return Object.freeze({
					...common,
					type: "EMAIL" as const,
					maskedValue: binding.maskedValue,
				});
			case "WECHAT":
				return Object.freeze({
					...common,
					type: "WECHAT" as const,
					maskedValue: "微信账号" as const,
				});
			case "QQ":
				return Object.freeze({
					...common,
					type: "QQ" as const,
					maskedValue: "QQ 账号" as const,
				});
		}
	}

	private identityHashes(
		identity: VerifiedExternalIdentity,
		secrets: ReadyAuthSecrets,
	): VerifiedOAuthHashes {
		return Object.freeze({
			lookup: hashIdentityLookup(
				identity.provider,
				identity.providerScope,
				identity.subject,
				secrets.hashKeyRing,
			),
			dedup: hashIdentityLookup(
				identity.provider,
				identity.providerScope,
				identity.subject,
				secrets.hashKeyRing,
				secrets.identityDedupKeyVersion,
			),
		});
	}

	private async verifyWechat(
		authorizationCode: string,
	): Promise<VerifiedExternalIdentity> {
		try {
			const identity = await this.wechatIdentityProvider.verify({
				authorizationCode,
			});
			if (identity.provider !== "WECHAT") throw new AuthUnavailableException();
			return identity;
		} catch (error) {
			this.mapIdentityFailure(error);
		}
	}

	private async verifyQq(
		accessToken: string,
	): Promise<VerifiedExternalIdentity> {
		try {
			const identity = await this.qqIdentityProvider.verify({ accessToken });
			if (identity.provider !== "QQ") throw new AuthUnavailableException();
			return identity;
		} catch (error) {
			this.mapIdentityFailure(error);
		}
	}

	private mapIdentityFailure(error: unknown): never {
		if (
			error instanceof ExternalIdentityUnavailableError &&
			(error.reason === "INVALID_PROOF" || error.reason === "UPSTREAM_REJECTED")
		) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		throw new AuthUnavailableException();
	}

	private async requireAccess(
		bearer: string | null,
		installationId?: string,
	): Promise<AuthenticatedUserContext> {
		if (bearer === null) throw new AuthUnauthorizedException();
		return this.authenticatedUserResolver.resolveAccessToken(
			bearer,
			installationId,
		);
	}

	private readySecrets(): ReadyAuthSecrets {
		if (
			!this.config.auth.enabled ||
			!this.repository.isAvailable() ||
			this.config.auth.hashKeyRing === null ||
			this.config.auth.identityDedupKeyVersion === null
		) {
			throw new AuthUnavailableException();
		}
		return Object.freeze({
			hashKeyRing: this.config.auth.hashKeyRing,
			otpPepperRing: this.config.auth.otpPepperRing,
			identityDedupKeyVersion: this.config.auth.identityDedupKeyVersion,
		});
	}

	private readyOtpPepper(secrets: ReadyAuthSecrets): AuthSecretKeyRing {
		if (secrets.otpPepperRing === null) {
			throw new AuthUnavailableException();
		}
		return secrets.otpPepperRing;
	}

	private async repositoryCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (
				error instanceof AuthUnauthorizedException ||
				error instanceof AuthConflictException ||
				error instanceof AuthRateLimitedException ||
				error instanceof AuthUnavailableException
			) {
				throw error;
			}
			throw new AuthUnavailableException();
		}
	}
}

function tokenHashCandidates(
	token: string,
	domain: "access-token" | "refresh-token",
	keyRing: AuthSecretKeyRing,
): readonly VersionedHash[] {
	return keyRing
		.versions()
		.map((version) => hashOpaqueToken(token, keyRing, domain, version));
}

function hashCandidates(
	domain: "device" | "oauth-state",
	value: string,
	keyRing: AuthSecretKeyRing,
): readonly VersionedHash[] {
	return keyRing
		.versions()
		.map((version) =>
			hashSensitiveRateLimitValue(domain, value, keyRing, version),
		);
}

function deviceHashValues(
	installationId: string,
	keyRing: AuthSecretKeyRing,
): readonly string[] {
	return hashCandidates("device", installationId, keyRing).map(
		(candidate) => candidate.value,
	);
}

function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

function maskPhone(value: string): string {
	return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

function maskEmail(value: string): string {
	const separator = value.lastIndexOf("@");
	const local = value.slice(0, separator);
	const domain = value.slice(separator + 1);
	const visibleStart = local.length > 1 ? local.slice(0, 1) : "";
	const visibleEnd = local.length > 2 ? local.slice(-1) : "";
	return `${visibleStart}****${visibleEnd}@${domain}`;
}

function assertDeviceLabel(value: string): void {
	if (/[<>&\p{Cc}]/u.test(value)) {
		throw new AuthInvalidRequestException();
	}
}
