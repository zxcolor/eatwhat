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

export const RateLimit = (maximum: number, windowMs: number) =>
	SetMetadata(RATE_LIMIT_POLICY, Object.freeze({ maximum, windowMs }));

@Injectable()
export class IpRateLimitGuard implements CanActivate {
	private readonly buckets = new Map<string, Bucket>();
	private lastCleanupAt = 0;

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
			this.buckets.set(key, { count: 1, resetAt: now + policy.windowMs });
			return true;
		}
		if (current.count >= policy.maximum) {
			const retryAfterSeconds = Math.max(
				1,
				Math.ceil((current.resetAt - now) / 1_000),
			);
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
		current.count += 1;
		return true;
	}

	private cleanupExpired(now: number, windowMs: number): void {
		if (now - this.lastCleanupAt < windowMs || this.buckets.size === 0) return;
		this.lastCleanupAt = now;
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) this.buckets.delete(key);
		}
		// A hard cap prevents unbounded memory growth if a future trusted proxy
		// configuration exposes many distinct client IPs.
		if (this.buckets.size > 20_000) {
			for (const key of [...this.buckets.keys()].slice(
				0,
				this.buckets.size - 20_000,
			)) {
				this.buckets.delete(key);
			}
		}
	}
}
