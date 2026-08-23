import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/database-pool.js";
import type { PlaceProvider } from "../recommendations/domain/place-candidate.js";
import { HealthController } from "./health.controller.js";

function database(ready: boolean): DatabasePool {
	return { isReady: vi.fn(async () => ready) } as unknown as DatabasePool;
}

function places(kind: "AMAP" | "UNAVAILABLE"): PlaceProvider {
	return { kind, dataMode: "LIVE" } as PlaceProvider;
}

describe("HealthController readiness", () => {
	it("keeps liveness independent from database and provider readiness", () => {
		const controller = new HealthController(database(false), places("UNAVAILABLE"));
		expect(controller.check()).toMatchObject({ status: "ok" });
	});

	it("returns ready only when the database and core recommendation provider are ready", async () => {
		const controller = new HealthController(database(true), places("AMAP"));
		await expect(controller.ready()).resolves.toMatchObject({ status: "ready" });
	});

	it.each([
		[false, "AMAP"],
		[true, "UNAVAILABLE"],
	] as const)(
		"returns one controlled error without exposing the failed dependency",
		async (databaseReady, providerKind) => {
			const controller = new HealthController(
				database(databaseReady),
				places(providerKind),
			);
			let caught: unknown;
			try {
				await controller.ready();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ServiceUnavailableException);
			expect((caught as ServiceUnavailableException).getResponse()).toEqual({
				code: "SERVICE_NOT_READY",
				message: "服务尚未就绪，请稍后重试",
			});
			expect(JSON.stringify(caught)).not.toMatch(/database|postgres|AMAP|provider/i);
		},
	);

	it("maps an unexpected probe failure to the same sanitized 503", async () => {
		const failingDatabase = {
			isReady: vi.fn(async () => {
				throw new Error(
					"postgresql://private-user:private-pass@private-host/database",
				);
			}),
		} as unknown as DatabasePool;
		const controller = new HealthController(failingDatabase, places("AMAP"));
		let caught: unknown;
		try {
			await controller.ready();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ServiceUnavailableException);
		expect((caught as ServiceUnavailableException).getResponse()).toEqual({
			code: "SERVICE_NOT_READY",
			message: "服务尚未就绪，请稍后重试",
		});
		expect(JSON.stringify(caught)).not.toContain("private-pass");
	});
});
