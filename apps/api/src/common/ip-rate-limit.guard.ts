import {
	type CanActivate,
	type ExecutionContext,
	HttpException,
	HttpStatus,
	Injectable,
	SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

interface RateLimitPolicy {
	readonly maximum: number;
	readonly windowMs: number;
}

interface Bucket {
	count: number;
	resetAt: number;
}

const RATE_LIMIT_POLICY = Symbol("RATE_LIMIT_POLICY");
const MAX_RATE_BUCKETS = 20_000;

export const RateLimit = (maximum: number, windowMs: number) =>
	SetMetadata(RATE_LIMIT_POLICY, Object.freeze({ maximum, windowMs }));

@Injectable()
export class IpRateLimitGuard implements CanActivate {
	private readonly buckets = new Map<string, Bucket>();
	private lastCleanupAt = 0;
	private capacityRetryAt = 0;
	private capacityScanAvailableAt = 0;

	constructor(private readonly reflector: Reflector) {}

	canActivate(context: ExecutionContext): boolean {
		const policy = this.reflector.getAllAndOverride<RateLimitPolicy>(
			RATE_LIMIT_POLICY,
			[context.getHandler(), context.getClass()],
		);
		if (policy === undefined) return true;

		const request = context.switchToHttp().getRequest<{
			readonly ip?: string;
			readonly socket?: { readonly remoteAddress?: string };
		}>();
		const response = context.switchToHttp().getResponse<{
			setHeader(name: string, value: string): void;
		}>();
		const now = Date.now();
		this.cleanupExpired(now, policy.windowMs);
		const clientAddress =
			request.ip ?? request.socket?.remoteAddress ?? "unknown";
		// Policies belong to handlers, not controller classes. Otherwise a strict
		// OTP endpoint can exhaust the unrelated login/session buckets merely
		// because the routes share one controller.
		const key = `${context.getClass().name}:${context.getHandler().name}:${clientAddress}`;
		const current = this.buckets.get(key);

		if (current === undefined || current.resetAt <= now) {
			if (current === undefined) {
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
		if (current.count >= policy.maximum) {
			this.reject(response, current.resetAt, now);
		}
		current.count += 1;
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
				code: "RATE_LIMITED",
				message: "请求过于频繁，请稍后重试",
				retryAfterSeconds,
			},
			HttpStatus.TOO_MANY_REQUESTS,
		);
	}

	private capacityLimit(now: number): number | null {
		if (this.buckets.size < MAX_RATE_BUCKETS) return null;
		if (now >= this.capacityRetryAt) {
			this.cleanupExpired(now, 0);
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
		return this.buckets.size >= MAX_RATE_BUCKETS ? this.capacityRetryAt : null;
	}

	private cleanupExpired(now: number, windowMs: number): void {
		if (now - this.lastCleanupAt < windowMs || this.buckets.size === 0) return;
		this.lastCleanupAt = now;
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) this.buckets.delete(key);
		}
	}
}
