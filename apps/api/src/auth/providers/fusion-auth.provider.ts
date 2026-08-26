import type { AuthRuntimeConfig } from "../auth-config.js";
import { SafeAliyunSdkError } from "./aliyun-official.clients.js";

export interface AliyunFusionRuntimeOptions {
	readonly autoretry: false;
	readonly maxAttempts: 1;
	readonly connectTimeout: number;
	readonly readTimeout: number;
	readonly keepAlive: false;
	readonly maxIdleConns: 1;
}

export interface AliyunFusionTokenRequest {
	readonly durationSeconds: number;
	readonly packageName: string;
	readonly packageSign: string;
	readonly platform: "Android";
	readonly schemeCode: string;
}

export interface AliyunFusionVerifyRequest {
	readonly verifyToken: string;
}

export interface AliyunFusionTokenResponse {
	readonly body?: {
		readonly code?: unknown;
		readonly success?: unknown;
		readonly model?: unknown;
	};
}

export interface AliyunFusionVerifyResponse {
	readonly body?: {
		readonly code?: unknown;
		readonly success?: unknown;
		readonly model?: {
			readonly verifyResult?: unknown;
			readonly phoneNumber?: unknown;
		};
	};
}

export interface AliyunFusionClient {
	getFusionAuthTokenWithOptions(
		request: AliyunFusionTokenRequest,
		runtime: AliyunFusionRuntimeOptions,
	): Promise<AliyunFusionTokenResponse>;
	verifyWithFusionAuthTokenWithOptions(
		request: AliyunFusionVerifyRequest,
		runtime: AliyunFusionRuntimeOptions,
	): Promise<AliyunFusionVerifyResponse>;
}

export type FusionAuthFailureReason =
	| "DISABLED"
	| "INVALID_PROOF"
	| "UPSTREAM_REJECTED"
	| "TIMEOUT"
	| "NETWORK_ERROR";

export class FusionAuthUnavailableError extends Error {
	constructor(readonly reason: FusionAuthFailureReason) {
		super("手机号认证暂不可用");
		this.name = "FusionAuthUnavailableError";
	}
}

export interface IssuedFusionAuthToken {
	readonly authToken: string;
}

export interface VerifiedFusionPhone {
	readonly e164PhoneNumber: string;
}

export interface FusionAuthProvider {
	issueToken(): Promise<IssuedFusionAuthToken>;
	verifyToken(verifyToken: string): Promise<VerifiedFusionPhone>;
}

function isSafeFusionToken(value: string): boolean {
	if (value.length < 1 || value.length > 4_096) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0) as number;
		if (/\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f) {
			return false;
		}
	}
	return true;
}

export class AliyunFusionAuthProvider implements FusionAuthProvider {
	constructor(
		private readonly config: AuthRuntimeConfig["fusion"],
		private readonly client: AliyunFusionClient,
	) {}

	async issueToken(): Promise<IssuedFusionAuthToken> {
		const { schemeCode, packageName, packageSign } = this.config;
		if (
			!this.config.enabled ||
			schemeCode === null ||
			packageName === null ||
			packageSign === null
		) {
			throw new FusionAuthUnavailableError("DISABLED");
		}
		try {
			const response = await this.client.getFusionAuthTokenWithOptions(
				{
					durationSeconds: Math.floor(this.config.tokenTtlMs / 1_000),
					packageName,
					packageSign,
					platform: "Android",
					schemeCode,
				},
				this.runtime(),
			);
			const token = response.body?.model;
			if (
				response.body?.code !== "OK" ||
				response.body.success !== true ||
				typeof token !== "string" ||
				!isSafeFusionToken(token)
			) {
				throw new FusionAuthUnavailableError("UPSTREAM_REJECTED");
			}
			return Object.freeze({ authToken: token });
		} catch (error) {
			this.mapFailure(error);
		}
	}

	async verifyToken(verifyToken: string): Promise<VerifiedFusionPhone> {
		if (!this.config.enabled || !isSafeFusionToken(verifyToken)) {
			throw new FusionAuthUnavailableError("INVALID_PROOF");
		}
		try {
			const response = await this.client.verifyWithFusionAuthTokenWithOptions(
				{ verifyToken },
				this.runtime(),
			);
			const model = response.body?.model;
			if (
				response.body?.code !== "OK" ||
				response.body.success !== true
			) {
				throw new FusionAuthUnavailableError("INVALID_PROOF");
			}
			if (
				model?.verifyResult !== "PASS" ||
				typeof model.phoneNumber !== "string" ||
				!/^1[3-9]\d{9}$/u.test(model.phoneNumber)
			) {
				throw new FusionAuthUnavailableError("INVALID_PROOF");
			}
			return Object.freeze({ e164PhoneNumber: `+86${model.phoneNumber}` });
		} catch (error) {
			this.mapFailure(error);
		}
	}

	private runtime(): AliyunFusionRuntimeOptions {
		return Object.freeze({
			autoretry: false as const,
			maxAttempts: 1 as const,
			connectTimeout: this.config.timeoutMs,
			readTimeout: this.config.timeoutMs,
			keepAlive: false as const,
			maxIdleConns: 1 as const,
		});
	}

	private mapFailure(error: unknown): never {
		if (error instanceof FusionAuthUnavailableError) throw error;
		if (error instanceof SafeAliyunSdkError) {
			throw new FusionAuthUnavailableError(error.reason);
		}
		throw new FusionAuthUnavailableError("NETWORK_ERROR");
	}
}
