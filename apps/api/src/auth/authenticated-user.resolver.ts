import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { AuthRepository } from "./auth.repository.js";
import { hashOpaqueToken, hashSensitiveRateLimitValue } from "./auth-crypto.js";
import {
	AuthUnauthorizedException,
	AuthUnavailableException,
} from "./auth-errors.js";
import { requireBearerAccessToken } from "./bearer-token.js";

/**
 * The only account context exposed to feature modules. In particular, callers
 * never receive the raw bearer, token hashes, key versions or configured keys.
 */
export interface AuthenticatedUserContext {
	readonly userId: string;
	readonly sessionId: string;
	readonly deviceHash: string;
}

export interface AuthenticatedUserResolver {
	resolveAuthorization(
		authorizationHeader: unknown,
		installationId?: string,
	): Promise<AuthenticatedUserContext>;
	resolveAccessToken(
		accessToken: string,
		installationId?: string,
	): Promise<AuthenticatedUserContext>;
}

export const AUTHENTICATED_USER_RESOLVER = Symbol(
	"AUTHENTICATED_USER_RESOLVER",
);

@Injectable()
export class DatabaseAuthenticatedUserResolver
	implements AuthenticatedUserResolver
{
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly repository: AuthRepository,
	) {}

	async resolveAuthorization(
		authorizationHeader: unknown,
		installationId?: string,
	): Promise<AuthenticatedUserContext> {
		return this.resolveAccessToken(
			requireBearerAccessToken(authorizationHeader),
			installationId,
		);
	}

	async resolveAccessToken(
		accessToken: string,
		installationId?: string,
	): Promise<AuthenticatedUserContext> {
		const keyRing = this.config.auth.hashKeyRing;
		if (
			!this.config.auth.enabled ||
			!this.repository.isAvailable() ||
			keyRing === null
		) {
			throw new AuthUnavailableException();
		}
		try {
			const session = await this.repository.authenticateAccess(
				keyRing
					.versions()
					.map((version) =>
						hashOpaqueToken(accessToken, keyRing, "access-token", version),
					),
				installationId === undefined
					? undefined
					: keyRing
							.versions()
							.map(
								(version) =>
									hashSensitiveRateLimitValue(
										"device",
										installationId,
										keyRing,
										version,
									).value,
							),
			);
			if (session === null) {
				throw new AuthUnauthorizedException("SESSION_EXPIRED");
			}
			return Object.freeze({
				userId: session.userId,
				sessionId: session.sessionId,
				deviceHash: session.deviceHash,
			});
		} catch (error) {
			if (error instanceof AuthUnauthorizedException) throw error;
			throw new AuthUnavailableException();
		}
	}
}
