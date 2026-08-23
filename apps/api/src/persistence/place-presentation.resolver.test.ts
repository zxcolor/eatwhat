import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { computeAmapWebServiceSignature } from "../providers/amap-request-signature.js";
import { getAmapFailureDiagnostic } from "../providers/amap-response-status.js";
import { AmapPlacePresentationAdapter } from "./place-presentation.resolver.js";

function signedConfig() {
	return loadAppConfig({
		NODE_ENV: "test",
		AMAP_ENABLED: "true",
		AMAP_WEB_SERVICE_KEY: "presentation-web-service-key",
		AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "presentation-private-key",
	});
}

describe("AMap persisted presentation adapter", () => {
	it("batches at the official 10-ID limit and signs each detail request", async () => {
		const ids = Array.from(
			{ length: 11 },
			(_, index) => `B${String(index + 1).padStart(9, "0")}`,
		);
		const requested: URL[] = [];
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			const url = new URL(String(input));
			requested.push(url);
			const requestIds = url.searchParams.get("id")?.split("|") ?? [];
			return new Response(
				JSON.stringify({
					status: "1",
					infocode: "10000",
					pois: requestIds.map((id) => ({
						id,
						name: `餐厅-${id}`,
						business: { cost: "28", opentime_today: "08:00-22:00" },
					})),
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const resolved = await new AmapPlacePresentationAdapter(
			signedConfig(),
			fetchMock,
		).resolveMany(ids);

		expect(resolved.size).toBe(11);
		expect(requested).toHaveLength(2);
		expect(requested[0]?.searchParams.get("id")?.split("|")).toHaveLength(10);
		expect(requested[1]?.searchParams.get("id")?.split("|")).toHaveLength(1);
		for (const url of requested) {
			expect(url.origin).toBe("https://restapi.amap.com");
			expect(url.pathname).toBe("/v5/place/detail");
			const signature = url.searchParams.get("sig");
			url.searchParams.delete("sig");
			expect(signature).toBe(
				computeAmapWebServiceSignature(
					url.searchParams,
					"presentation-private-key",
				),
			);
		}
	});

	it("rejects null, boolean and array cost shapes while accepting canonical numerics", async () => {
		const cases = [
			{ id: "B000000001", cost: null, expected: null },
			{ id: "B000000002", cost: false, expected: null },
			{ id: "B000000003", cost: [], expected: null },
			{ id: "B000000004", cost: "28.50", expected: 28.5 },
			{ id: "B000000005", cost: 31.5, expected: 31.5 },
		] as const;
		const adapter = new AmapPlacePresentationAdapter(
			signedConfig(),
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "1",
							infocode: "10000",
							pois: cases.map(({ id, cost }) => ({
								id,
								name: `餐厅-${id}`,
								business: { cost },
							})),
						}),
						{ status: 200 },
					),
			) as typeof fetch,
		);

		const resolved = await adapter.resolveMany(cases.map(({ id }) => id));

		for (const { id, expected } of cases) {
			expect(resolved.get(id)).toMatchObject({
				presentationStatus: "AVAILABLE",
				averageCostYuan: expected,
			});
		}
	});

	it("shares one configured deadline across all detail batches", async () => {
		const config = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "presentation-web-service-key",
			AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "presentation-private-key",
			AMAP_TIMEOUT_MS: "500",
		});
		const ids = Array.from(
			{ length: 11 },
			(_, index) => `B${String(index + 1).padStart(9, "0")}`,
		);
		const fetchMock = vi.fn(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				await new Promise<void>((resolve, reject) => {
					const signal = init?.signal;
					if (signal?.aborted) {
						reject(new Error("upstream request aborted"));
						return;
					}
					let timer: ReturnType<typeof setTimeout>;
					const onAbort = () => {
						clearTimeout(timer);
						reject(new Error("upstream request aborted"));
					};
					timer = setTimeout(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					}, 300);
					signal?.addEventListener("abort", onAbort, { once: true });
				});
				const requestIds =
					new URL(String(input)).searchParams.get("id")?.split("|") ?? [];
				return new Response(
					JSON.stringify({
						status: "1",
						infocode: "10000",
						pois: requestIds.map((id) => ({ id, name: `餐厅-${id}` })),
					}),
					{ status: 200 },
				);
			},
		) as typeof fetch;
		const adapter = new AmapPlacePresentationAdapter(config, fetchMock);

		await expect(adapter.resolveMany(ids)).rejects.toThrow("AMap timeout");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("uses the same safe official failure classification as live search", async () => {
		const adapter = new AmapPlacePresentationAdapter(
			signedConfig(),
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "0",
							infocode: "10003",
							info: "private upstream detail must not cross the boundary",
						}),
						{ status: 200 },
					),
			) as typeof fetch,
		);

		let caught: unknown;
		try {
			await adapter.resolveMany(["B000000001"]);
		} catch (error) {
			caught = error;
		}
		expect(getAmapFailureDiagnostic(caught)).toEqual({
			classification: "QUOTA_OR_RATE_LIMIT",
			safeInfocode: "10003",
		});
		expect(String(caught)).not.toContain("private upstream detail");
	});

	it("applies the configured timeout while reading a stalled detail response body", async () => {
		const config = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "presentation-web-service-key",
			AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "presentation-private-key",
			AMAP_TIMEOUT_MS: "500",
		});
		const adapter = new AmapPlacePresentationAdapter(
			config,
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('{"status":"1"'));
							},
						}),
						{ status: 200 },
					),
			) as typeof fetch,
		);

		await expect(adapter.resolveMany(["B000000001"])).rejects.toThrow(
			"AMap timeout",
		);
	});
});
