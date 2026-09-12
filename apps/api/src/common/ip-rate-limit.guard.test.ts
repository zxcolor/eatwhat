import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { IpRateLimitGuard } from "./ip-rate-limit.guard.js";

class TestController {
	first(): void {}

	second(): void {}
}

function contextFor(
	handler: () => void,
	responseHeaders: Map<string, string> = new Map(),
	ip = "127.0.0.1",
): ExecutionContext {
	return {
		getClass: () => TestController,
		getHandler: () => handler,
		switchToHttp: () => ({
			getRequest: () => ({ ip }),
			getResponse: () => ({
				setHeader: (name: string, value: string) => {
					responseHeaders.set(name, value);
				},
			}),
		}),
	} as unknown as ExecutionContext;
}

describe("IP rate-limit policy isolation", () => {
	it("updates a full-capacity retry when reclaimed space receives a shorter-lived bucket", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		try {
			let windowMs = 60_000;
			const guard = new IpRateLimitGuard({
				getAllAndOverride: () => ({ maximum: 1, windowMs }),
			} as unknown as Reflector);
			const request = (address: string, duration: number) => {
				windowMs = duration;
				return guard.canActivate(
					contextFor(TestController.prototype.first, new Map(), address),
				);
			};
			for (let index = 0; index < 20_000; index += 1) {
				request(
					`2001:db8::${index.toString(16)}`,
					index < 2 ? 60_000 : 600_000,
				);
			}
			clock.mockReturnValue(1_060_000);
			expect(request("2001:db8::fffd", 600_000)).toBe(true);
			expect(request("2001:db8::fffe", 60_000)).toBe(true);
			clock.mockReturnValue(1_120_000);
			expect(request("2001:db8::ffff", 600_000)).toBe(true);
			expect(() => request("2001:db8::2", 600_000)).toThrow(
				expect.objectContaining({ status: 429 }),
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("rejects new IPs at capacity without evicting active limits and recovers after expiry", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		try {
			let windowMs = 60_000;
			const reflector = {
				getAllAndOverride: () => ({ maximum: 1, windowMs }),
			} as unknown as Reflector;
			const guard = new IpRateLimitGuard(reflector);
			for (let index = 0; index < 20_000; index += 1) {
				guard.canActivate(
					contextFor(
						TestController.prototype.first,
						new Map(),
						`2001:db8::${index.toString(16)}`,
					),
				);
			}
			const headers = new Map<string, string>();
			const newcomer = contextFor(
				TestController.prototype.first,
				headers,
				"2001:db8::ffff",
			);
			expect(() => guard.canActivate(newcomer)).toThrow(
				expect.objectContaining({ status: 429 }),
			);
			expect(headers.get("Retry-After")).toBe("60");
			expect(() =>
				guard.canActivate(
					contextFor(TestController.prototype.first, new Map(), "2001:db8::0"),
				),
			).toThrow(expect.objectContaining({ status: 429 }));
			const buckets = (guard as unknown as { buckets: Map<string, unknown> })
				.buckets;
			expect(buckets.size).toBe(20_000);

			clock.mockReturnValue(1_060_000);
			// A longer policy must still release capacity occupied by expired
			// shorter policies, even before its periodic cleanup would run.
			windowMs = 600_000;
			expect(guard.canActivate(newcomer)).toBe(true);
			expect(buckets.size).toBe(1);
			for (let index = 0; index < 19_999; index += 1) {
				guard.canActivate(
					contextFor(
						TestController.prototype.first,
						new Map(),
						`2001:db8::${index.toString(16)}`,
					),
				);
			}
			const nextHeaders = new Map<string, string>();
			expect(() =>
				guard.canActivate(
					contextFor(
						TestController.prototype.first,
						nextHeaders,
						"2001:db8::fffe",
					),
				),
			).toThrow(expect.objectContaining({ status: 429 }));
			expect(Number.isFinite(Number(nextHeaders.get("Retry-After")))).toBe(
				true,
			);
			expect(buckets.size).toBe(20_000);
		} finally {
			clock.mockRestore();
		}
	});

	it("uses an independent bucket for each handler in one controller", () => {
		const reflector = {
			getAllAndOverride: () => ({ maximum: 1, windowMs: 60_000 }),
		} as unknown as Reflector;
		const guard = new IpRateLimitGuard(reflector);
		const first = contextFor(TestController.prototype.first);
		const second = contextFor(TestController.prototype.second);

		expect(guard.canActivate(first)).toBe(true);
		expect(() => guard.canActivate(first)).toThrow();
		expect(guard.canActivate(second)).toBe(true);
	});

	it("sets a standards-compatible Retry-After header on a rejected request", () => {
		const reflector = {
			getAllAndOverride: () => ({ maximum: 1, windowMs: 60_000 }),
		} as unknown as Reflector;
		const guard = new IpRateLimitGuard(reflector);
		const headers = new Map<string, string>();
		const context = contextFor(TestController.prototype.first, headers);

		expect(guard.canActivate(context)).toBe(true);
		expect(() => guard.canActivate(context)).toThrow();
		expect(Number(headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
	});
});
