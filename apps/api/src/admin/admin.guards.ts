import type { AdminPermissionCode } from "@chi-shen-me/contracts";
import { AdminPermissionCodeSchema } from "@chi-shen-me/contracts";
import {
	type CanActivate,
	type ExecutionContext,
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
	type AdminAuthenticatedSession,
	AdminRepository,
	type AdminSessionProof,
} from "./admin.repository.js";
import { AdminCrypto } from "./admin-crypto.js";
import {
	adminForbidden,
	adminSessionInvalid,
	adminUnavailable,
} from "./admin-errors.js";
import {
	ADMIN_PROCESS_CONFIG,
	type AdminProcessConfig,
} from "./admin-process-config.js";
import {
	type AdminHttpRequest,
	AdminRequestContextFactory,
} from "./admin-request-context.js";

export const ADMIN_PRINCIPAL = Symbol("ADMIN_PRINCIPAL");

export interface AdminPrincipal {
	readonly adminUserId: string;
	readonly sessionId: string;
	readonly sessionProof: AdminSessionProof;
	readonly permissions: readonly AdminPermissionCode[];
	readonly absoluteExpiresAt: string;
}

export interface AuthenticatedAdminHttpRequest extends AdminHttpRequest {
	[ADMIN_PRINCIPAL]?: AdminPrincipal;
}

const REQUIRED_ADMIN_PERMISSION = Symbol("REQUIRED_ADMIN_PERMISSION");

export const RequireAdminPermission = (permission: AdminPermissionCode) =>
	SetMetadata(REQUIRED_ADMIN_PERMISSION, permission);

const ADMIN_RATE_LIMIT_POLICY = Symbol("ADMIN_RATE_LIMIT_POLICY");
const MAX_ADMIN_RATE_BUCKETS = 5_000;

interface AdminRateLimitPolicy {
	readonly maximum: number;
	readonly windowMs: number;
}

interface AdminRateBucket {
	count: number;
	resetAt: number;
}

export const AdminRateLimit = (maximum: number, windowMs: number) =>
	SetMetadata(ADMIN_RATE_LIMIT_POLICY, Object.freeze({ maximum, windowMs }));

@Injectable()
export class AdminApiEnabledGuard implements CanActivate {
	constructor(
		@Inject(ADMIN_PROCESS_CONFIG) private readonly config: AdminProcessConfig,
	) {}

	canActivate(): boolean {
		if (!this.config.admin.enabled) throw adminUnavailable();
		return true;
	}
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
	constructor(
		@Inject(ADMIN_PROCESS_CONFIG) private readonly config: AdminProcessConfig,
		private readonly contexts: AdminRequestContextFactory,
		private readonly repository: AdminRepository,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (!this.config.admin.enabled || !this.repository.isAvailable()) {
			throw adminUnavailable();
		}
		const request = context
			.switchToHttp()
			.getRequest<AuthenticatedAdminHttpRequest>();
		const rawToken = this.parseBearer(request.headers.authorization);
		let candidates: readonly AdminSessionProof[];
		try {
			candidates = this.contexts.sessionProofCandidates(request, rawToken);
		} catch {
			throw adminSessionInvalid();
		}

		let authenticated:
			| {
					readonly session: AdminAuthenticatedSession;
					readonly proof: AdminSessionProof;
			  }
			| undefined;
		try {
			for (const proof of candidates) {
				const session = await this.repository.authenticateSession(proof);
				if (session !== null) {
					authenticated = { session, proof };
					break;
				}
			}
		} catch {
			throw adminUnavailable();
		}
		if (authenticated === undefined) throw adminSessionInvalid();

		const parsedPermissions = AdminPermissionCodeSchema.array()
			.max(9)
			.safeParse(authenticated.session.permissionCodes);
		if (!parsedPermissions.success) throw adminUnavailable();
		request[ADMIN_PRINCIPAL] = Object.freeze({
			adminUserId: authenticated.session.adminUserId,
			sessionId: authenticated.session.sessionId,
			sessionProof: authenticated.proof,
			permissions: Object.freeze([...parsedPermissions.data]),
			absoluteExpiresAt: authenticated.session.absoluteExpiresAt,
		});
		return true;
	}

	private parseBearer(value: string | string[] | undefined): string {
		if (typeof value !== "string") throw adminSessionInvalid();
		const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(value);
		if (match?.[1] === undefined) throw adminSessionInvalid();
		return match[1];
	}
}

@Injectable()
export class AdminPermissionGuard implements CanActivate {
	constructor(private readonly reflector: Reflector) {}

	canActivate(context: ExecutionContext): boolean {
		const required = this.reflector.getAllAndOverride<AdminPermissionCode>(
			REQUIRED_ADMIN_PERMISSION,
			[context.getHandler(), context.getClass()],
		);
		if (required === undefined) return true;
		const request = context
			.switchToHttp()
			.getRequest<AuthenticatedAdminHttpRequest>();
		const principal = request[ADMIN_PRINCIPAL];
		if (principal === undefined || !principal.permissions.includes(required)) {
			throw adminForbidden();
		}
		return true;
	}
}

@Injectable()
export class AdminRateLimitGuard implements CanActivate {
	private readonly buckets = new Map<string, AdminRateBucket>();
	private lastCleanupAt = 0;
	private capacityRetryAt = 0;
	private capacityScanAvailableAt = 0;

	constructor(
		private readonly reflector: Reflector,
		private readonly crypto: AdminCrypto,
	) {}

	canActivate(context: ExecutionContext): boolean {
		const policy = this.reflector.getAllAndOverride<AdminRateLimitPolicy>(
			ADMIN_RATE_LIMIT_POLICY,
			[context.getHandler(), context.getClass()],
		);
		if (policy === undefined) return true;
		const request = context.switchToHttp().getRequest<AdminHttpRequest>();
		const response = context.switchToHttp().getResponse<{
			setHeader(name: string, value: string): void;
		}>();
		const now = Date.now();
		this.cleanup(now, policy.windowMs);
		const rawAddress =
			request.ip ?? request.socket?.remoteAddress ?? "unavailable";
		const address = rawAddress.length <= 64 ? rawAddress : "invalid";
		const addressHash = this.crypto.currentHash("REQUEST_IP", address).value;
		const key = `${context.getClass().name}:${context.getHandler().name}:${addressHash}`;
		const bucket = this.buckets.get(key);
		if (bucket === undefined || bucket.resetAt <= now) {
			if (bucket === undefined) {
				const retryAt = this.capacityLimit(now);
				if (retryAt !== null) this.reject(response, retryAt, now);
			}
			const resetAt = now + policy.windowMs;
			this.buckets.set(key, { count: 1, resetAt });
			// Reclaimed space may receive a shorter policy than the remaining
			// buckets. Its expiry must shorten the cached capacity retry as well.
			this.capacityRetryAt = Math.min(
				this.capacityRetryAt,
				Math.max(resetAt, this.capacityScanAvailableAt),
			);
			return true;
		}
		if (bucket.count >= policy.maximum) {
			this.reject(response, bucket.resetAt, now);
		}
		bucket.count += 1;
		return true;
	}

	private reject(
		response: { setHeader(name: string, value: string): void },
		resetAt: number,
		now: number,
	): never {
		const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1_000));
		response.setHeader("Retry-After", String(retryAfterSeconds));
		throw new HttpException(
			{
				code: "ADMIN_RATE_LIMITED",
				message: "管理员请求过于频繁，请稍后重试",
				retryAfterSeconds,
			},
			HttpStatus.TOO_MANY_REQUESTS,
		);
	}

	private capacityLimit(now: number): number | null {
		if (this.buckets.size < MAX_ADMIN_RATE_BUCKETS) return null;
		if (now >= this.capacityRetryAt) {
			this.cleanup(now, 0);
			this.capacityScanAvailableAt = now + 1_000;
			let firstExpiry = Number.POSITIVE_INFINITY;
			for (const bucket of this.buckets.values()) {
				firstExpiry = Math.min(firstExpiry, bucket.resetAt);
			}
			// Bound scans under a burst of new addresses, including staggered expiry.
			this.capacityRetryAt = Number.isFinite(firstExpiry)
				? Math.max(this.capacityScanAvailableAt, firstExpiry)
				: this.capacityScanAvailableAt;
		}
		// Never evict an active bucket: doing so would reset an existing limit.
		return this.buckets.size >= MAX_ADMIN_RATE_BUCKETS
			? this.capacityRetryAt
			: null;
	}

	private cleanup(now: number, windowMs: number): void {
		if (now - this.lastCleanupAt < windowMs || this.buckets.size === 0) return;
		this.lastCleanupAt = now;
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) this.buckets.delete(key);
		}
	}
}
