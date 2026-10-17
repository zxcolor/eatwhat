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
	IdentityBinding,
	IdentityBindingsResponse,
	LatestAccountExportResponse,
	ListSessionsQuery,
	LoginRequest,
	LogoutResponse,
	OAuthStateRequest,
	OAuthStateResponse,
	PhoneCodeChallengeResponse,
	PhoneRequestCode,
	RefreshRequest,
	RevokeSessionResponse,
	SessionsResponse,
	UnbindIdentityResponse,
	WechatMiniProgramLoginRequest,
} from "@chi-shen-me/contracts";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import {
	AuthRepository,
	type CompleteBindingResult,
	type DataExportRecord,
	type IdentityBindingRecord,
} from "./auth.repository.js";
import {
	type AuthSecretKeyRing,
	constantTimeHashEquals,
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
	PHONE_OTP_PROVIDER,
	QQ_IDENTITY_PROVIDER,
	WECHAT_IDENTITY_PROVIDER,
	WECHAT_MINIPROGRAM_IDENTITY_PROVIDER,
} from "./auth-provider.factories.js";
import type {
	CompleteOAuthCredentialResult,
	OAuthProof,
	OtpProof,
	SessionIssueDraft,
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
	type PhoneOtpProvider,
} from "./providers/otp-delivery.provider.js";

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
		private readonly phoneOtpProvider: PhoneOtpProvider,
		@Inject(EMAIL_OTP_PROVIDER)
		private readonly emailOtpProvider: OtpDeliveryProvider,
		@Inject(WECHAT_IDENTITY_PROVIDER)
		private readonly wechatIdentityProvider: WechatIdentityProvider,
		@Inject(QQ_IDENTITY_PROVIDER)
		private readonly qqIdentityProvider: QqIdentityProvider,
		@Inject(AUTHENTICATED_USER_RESOLVER)
		private readonly authenticatedUserResolver: AuthenticatedUserResolver,
		@Inject(EXPORT_ARTIFACT_READER)
		private readonly exportArtifactReader: ExportArtifactReader,
		@Optional()
		@Inject(WECHAT_MINIPROGRAM_IDENTITY_PROVIDER)
		private readonly wechatMiniProgramIdentityProvider?: WechatIdentityProvider,
	) {}

	async requestPhoneCode(
		input: PhoneRequestCode,
		bearer: string | null,
		clientIp: string,
	): Promise<PhoneCodeChallengeResponse> {
		if (input.purpose === "REGISTER") {
			if (!this.config.auth.registrationEnabled) {
				throw new AuthUnavailableException();
			}
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
		const secrets = this.readySecrets();
		const hashKeyVersion = secrets.hashKeyRing.activeVersion;
		let flowReferenceHash: string;
		let deviceHash: string;
		let targetUserId: string | null = null;
		let operationTargetHash: string | null = null;
		if (input.purpose === "BIND") {
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
		return this.loginWithOAuth(input, clientIp, secrets);
	}

	async loginWechatMiniProgram(
		input: WechatMiniProgramLoginRequest,
		clientIp: string,
	): Promise<AuthTokenResponse> {
		const channel = this.config.auth.wechatMiniProgram;
		if (
			!channel.enabled ||
			channel.appId === null ||
			channel.appSecret === null ||
			channel.openPlatformRealmId === null ||
			this.wechatMiniProgramIdentityProvider === undefined
		)
			throw new AuthUnavailableException();
		const secrets = this.readySecrets();
		if (input.device.platform !== "MINIPROGRAM")
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		assertDeviceLabel(input.device.label);
		// Stable key version makes a code claim survive ordinary HMAC key rotation.
		// Domain separation prevents collision with client-issued OAuth states.
		const hashKeyVersion = secrets.identityDedupKeyVersion;
		const stateHash = hashSensitiveRateLimitValue(
			"oauth-state",
			`miniprogram-code:${channel.appId}:${input.code}`,
			secrets.hashKeyRing,
			hashKeyVersion,
		);
		const deviceHash = hashSensitiveRateLimitValue(
			"device",
			input.device.installationId,
			secrets.hashKeyRing,
			hashKeyVersion,
		).value;
		const flowReferenceHash = hashSensitiveRateLimitValue(
			"ip",
			clientIp,
			secrets.hashKeyRing,
			hashKeyVersion,
		).value;
		const createdAt = new Date();
		const proof: OAuthProof = {
			id: randomUUID(),
			provider: "WECHAT",
			purpose: "LOGIN",
			flowReferenceHash,
			operationTargetHash: null,
			targetUserId: null,
			deviceHash,
			hashKeyVersion,
		};
		const claim = await this.repositoryCall(() =>
			this.repository.claimWechatMiniProgramCode({
				...proof,
				stateHash,
				createdAt,
				expiresAt: new Date(
					createdAt.getTime() +
						Math.min(this.config.auth.oauthStateTtlMs, 5 * 60_000),
				),
				retainUntil: new Date(createdAt.getTime() + 24 * 60 * 60_000),
			}),
		);
		if (claim.kind === "RATE_LIMITED")
			throw new AuthRateLimitedException(claim.retryAfterSeconds);
		if (claim.kind === "REPLAY")
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		let identity: VerifiedExternalIdentity;
		try {
			identity = await this.wechatMiniProgramIdentityProvider.verify({
				authorizationCode: input.code,
			});
		} catch (error) {
			this.mapIdentityFailure(error);
		}
		if (
			identity.provider !== "WECHAT" ||
			identity.providerScope !== channel.appId
		)
			throw new AuthUnavailableException();
		if (identity.unionSubject === null)
			throw new AuthUnauthorizedException("IDENTITY_NOT_BOUND");
		const realmId = channel.openPlatformRealmId;
		const issued = this.issueSession(
			input.device,
			clientIp,
			hashKeyVersion,
			secrets.hashKeyRing,
			deviceHash,
		);
		const result = await this.repositoryCall(() =>
			this.repository.completeWechatMiniProgramLogin({
				proof,
				verifiedIdentity: this.identityHashes(identity, secrets, realmId),
				session: issued.draft,
			}),
		);
		return this.tokenResponse(result, issued);
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
			(input.type === "WECHAT" && !this.config.auth.wechat.enabled) ||
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
			if (
				proof.verificationMethod !== "LOCAL_HASH" ||
				proof.codeHash === null ||
				proof.codeHashKeyVersion === null
			) {
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
				input.type,
				"BIND",
				[session.deviceHash],
			),
		);
		if (!this.bindingProofMatchesSession(proof, session)) {
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
		}
		const verified =
			input.type === "WECHAT"
				? await this.verifyWechat(input.authorizationCode)
				: await this.verifyQq(input.authorizationCode);
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
	async listSessions(
		bearer: string,
		query: ListSessionsQuery = {},
	): Promise<SessionsResponse> {
		const session =
			await this.authenticatedUserResolver.resolveAccessToken(bearer);
		const sessions = await this.repositoryCall(() =>
			this.repository.listSessions(session, query.includePlatforms === "ALL"),
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

	private requireLoginChannelEnabled(method: LoginRequest["method"]): void {
		const enabled =
			method === "PHONE"
				? this.config.auth.phone.enabled
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

		// PNVS generates and verifies phone codes. Only email challenges retain a
		// local peppered hash; no usable phone OTP is ever generated or persisted.
		const code = channel === "EMAIL" ? generateSixDigitOtp() : null;
		const challengeId = randomUUID();
		const idempotencyKey = challengeId;
		const codeHash =
			code === null
				? null
				: await hashOtpCode(code, this.readyOtpPepper(secrets));
		const createdAt = new Date();
		const expiresAt = new Date(createdAt.getTime() + this.config.auth.otpTtlMs);
		const resendAvailableAt = new Date(
			createdAt.getTime() + this.config.auth.otpResendDelayMs,
		);
		const destinationScope = channel === "PHONE" ? "e164" : "email-lowercase";
		const draft = Object.freeze({
			id: challengeId,
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
			verificationMethod:
				channel === "PHONE"
					? ("ALIYUN_PNVS" as const)
					: ("LOCAL_HASH" as const),
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
			if (
				error instanceof OtpDeliveryUnavailableError &&
				(error.reason === "DISABLED" ||
					error.reason === "INVALID_REQUEST" ||
					error.reason === "UPSTREAM_REJECTED")
			) {
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
		const deviceHashes = deviceHashValues(
			input.device.installationId,
			secrets.hashKeyRing,
		);
		let proof = await this.repositoryCall(() =>
			this.repository.findOtpProof(
				input.challengeId,
				input.method,
				"LOGIN",
				deviceHashes,
			),
		);
		if (
			proof === null &&
			input.method === "PHONE" &&
			this.config.auth.registrationEnabled
		) {
			proof = await this.repositoryCall(() =>
				this.repository.findOtpProof(
					input.challengeId,
					"PHONE",
					"REGISTER",
					deviceHashes,
				),
			);
		}
		if (proof === null)
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");

		let verificationClaimHash: string | null = null;
		let valid: boolean;
		if (input.method === "PHONE") {
			if (
				proof.verificationMethod !== "ALIYUN_PNVS" ||
				proof.codeHash !== null ||
				proof.codeHashKeyVersion !== null
			) {
				throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
			}
			const destinationHash = hashIdentityLookup(
				"PHONE",
				"e164",
				input.phoneNumber,
				secrets.hashKeyRing,
				secrets.identityDedupKeyVersion,
			).value;
			const destinationMatches = constantTimeHashEquals(
				destinationHash,
				proof.destinationDedupHash,
			);
			verificationClaimHash = hashSensitiveRateLimitValue(
				"idempotency",
				generateOAuthState(),
				secrets.hashKeyRing,
				proof.hashKeyVersion,
			).value;
			const claimed = await this.repositoryCall(() =>
				this.repository.claimPhoneOtpVerification(
					proof as OtpProof,
					verificationClaimHash as string,
					new Date(Date.now() + 30_000),
				),
			);
			if (!claimed) {
				throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
			}
			try {
				valid = destinationMatches
					? await this.phoneOtpProvider.verify({
							destination: input.phoneNumber,
							code: input.otpCode,
							idempotencyKey: proof.id,
						})
					: false;
			} catch {
				await this.repositoryCall(() =>
					this.repository.releasePhoneOtpVerification(
						proof as OtpProof,
						verificationClaimHash as string,
					),
				).catch(() => undefined);
				throw new AuthUnavailableException();
			}
		} else {
			if (
				proof.verificationMethod !== "LOCAL_HASH" ||
				proof.codeHash === null ||
				proof.codeHashKeyVersion === null
			) {
				throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
			}
			valid = await verifyOtpCode(
				input.otpCode,
				proof.codeHash,
				proof.codeHashKeyVersion,
				this.readyOtpPepper(secrets),
			);
		}
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
				newUserId:
					proof.channel === "PHONE" && proof.purpose === "REGISTER"
						? randomUUID()
						: null,
				verificationClaimHash,
			}),
		);
		if (issued === null)
			throw new AuthUnauthorizedException("INVALID_CREDENTIALS");
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
				: await this.verifyQq(input.authorizationCode);
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
		result: CompleteOAuthCredentialResult,
		issued: {
			readonly draft: SessionIssueDraft;
			readonly access: IssuedOpaqueToken;
			readonly refresh: IssuedOpaqueToken;
		},
	): AuthTokenResponse {
		if (result.kind === "IDENTITY_CONFLICT") {
			throw new AuthConflictException("IDENTITY_BINDING_CONFLICT");
		}
		if (result.kind === "IDENTITY_NOT_BOUND") {
			throw new AuthUnauthorizedException("IDENTITY_NOT_BOUND");
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
		wechatRealmOverride?: string,
	): VerifiedOAuthHashes {
		// Keep each durable lookup AppID-scoped. QQ may use a separately realm-
		// scoped UnionID only for deduplication; WeChat keeps its existing alias
		// record. Neither path replaces or impersonates the App-scoped OpenID.
		const stableDedupSubject =
			identity.provider === "QQ" && identity.unionSubject !== null
				? Object.freeze({
						scope: `open-platform:${this.requireQqOpenPlatformRealmId()}`,
						value: identity.unionSubject,
					})
				: Object.freeze({
						scope: identity.providerScope,
						value: identity.subject,
					});
		return Object.freeze({
			lookup: hashIdentityLookup(
				identity.provider,
				identity.providerScope,
				identity.subject,
				secrets.hashKeyRing,
			),
			dedup: hashIdentityLookup(
				identity.provider,
				stableDedupSubject.scope,
				stableDedupSubject.value,
				secrets.hashKeyRing,
				secrets.identityDedupKeyVersion,
			),
			wechatUnionAlias:
				identity.provider === "WECHAT" && identity.unionSubject !== null
					? Object.freeze({
							realmId:
								wechatRealmOverride ?? this.requireWechatOpenPlatformRealmId(),
							hash: hashIdentityLookup(
								"WECHAT",
								`open-platform:${wechatRealmOverride ?? this.requireWechatOpenPlatformRealmId()}`,
								identity.unionSubject,
								secrets.hashKeyRing,
								secrets.identityDedupKeyVersion,
							),
						})
					: null,
		});
	}

	private requireWechatOpenPlatformRealmId(): string {
		const realmId = this.config.auth.wechat.openPlatformRealmId;
		if (realmId === null) throw new AuthUnavailableException();
		return realmId;
	}

	private requireQqOpenPlatformRealmId(): string {
		const realmId = this.config.auth.qq.openPlatformRealmId;
		if (realmId === null) throw new AuthUnavailableException();
		return realmId;
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
		authorizationCode: string,
	): Promise<VerifiedExternalIdentity> {
		try {
			const identity = await this.qqIdentityProvider.verify({
				authorizationCode,
			});
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
