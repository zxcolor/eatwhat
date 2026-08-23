import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { IpRateLimitGuard } from "./ip-rate-limit.guard.js";

class TestController {
	first(): void {}

	second(): void {}
}

function contextFor(
	handler: () => void,
	responseHeaders: Map<string, string> = new Map(),
): ExecutionContext {
	return {
		getClass: () => TestController,
		getHandler: () => handler,
		switchToHttp: () => ({
			getRequest: () => ({ ip: "127.0.0.1" }),
			getResponse: () => ({
				setHeader: (name: string, value: string) => {
					responseHeaders.set(name, value);
				},
			}),
		}),
	} as unknown as ExecutionContext;
}

describe("IP rate-limit policy isolation", () => {
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
