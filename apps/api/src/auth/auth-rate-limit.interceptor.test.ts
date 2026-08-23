import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { AuthRateLimitedException } from "./auth-errors.js";
import { AuthRateLimitInterceptor } from "./auth-rate-limit.interceptor.js";

describe("AuthRateLimitInterceptor", () => {
	it("adds a standards-compliant Retry-After header and rethrows the safe error", async () => {
		const setHeader = vi.fn();
		const context = {
			switchToHttp: () => ({ getResponse: () => ({ setHeader }) }),
		} as unknown as ExecutionContext;
		const failure = new AuthRateLimitedException(31.2);
		const next = {
			handle: () => throwError(() => failure),
		} as CallHandler;

		await expect(
			firstValueFrom(new AuthRateLimitInterceptor().intercept(context, next)),
		).rejects.toBe(failure);
		expect(setHeader).toHaveBeenCalledWith("Retry-After", "32");
		expect(failure.getResponse()).toMatchObject({ retryAfterSeconds: 32 });
	});
});
