import { describe, expect, it, vi } from "vitest";
import {
	runAmapLiveSmoke,
	safeAmapLiveSmokeFailure,
} from "./amap-real-key.smoke.js";

function enabledEnv(
	overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
	return {
		AMAP_LIVE_SMOKE_ENABLED: "true",
		AMAP_ENABLED: "true",
		AMAP_WEB_SERVICE_KEY: "private-live-smoke-key",
		AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "private-live-signing-key",
		AMAP_IP_WHITELIST_CONFIGURED: "true",
		AMAP_TIMEOUT_MS: "2200",
		...overrides,
	};
}

function successfulAmapFetch(observedPaths: string[]): typeof fetch {
	return async (input: URL | RequestInfo) => {
		const url = new URL(
			input instanceof URL
				? input.href
				: typeof input === "string"
					? input
					: input.url,
		);
		observedPaths.push(url.pathname);
		if (url.pathname === "/v5/place/text") {
			return new Response(
				JSON.stringify({
					status: "1",
					infocode: "10000",
					pois: [
						{
							name: "固定测试地点",
							address: "固定测试地址",
							location: "116.310900,39.992800",
							adcode: "110108",
						},
					],
				}),
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({
				status: "1",
				infocode: "10000",
				pois: [
					{
						id: "PRIVATE-UPSTREAM-POI-ID",
						name: "固定测试餐厅",
						address: "固定测试地址",
						location: "116.311000,39.992900",
						distance: "30",
						adcode: "110108",
						type: "餐饮服务;中餐厅",
						business: {
							rating: "4.5",
							cost: "30",
							tag: "面食",
							opentime_today: "全天",
						},
					},
				],
			}),
			{ status: 200 },
		);
	};
}

describe("AMap real-key smoke safety harness", () => {
	it.each([
		{
			name: "explicit command confirmation is missing",
			confirmLiveRequest: false,
			env: enabledEnv(),
			classification: "CONFIRMATION_REQUIRED",
		},
		{
			name: "the live smoke environment gate is closed",
			confirmLiveRequest: true,
			env: enabledEnv({ AMAP_LIVE_SMOKE_ENABLED: "false" }),
			classification: "LIVE_SMOKE_DISABLED",
		},
		{
			name: "the AMap integration gate is closed",
			confirmLiveRequest: true,
			env: enabledEnv({ AMAP_ENABLED: "false" }),
			classification: "AMAP_DISABLED",
		},
		{
			name: "the server-side key is absent",
			confirmLiveRequest: true,
			env: enabledEnv({ AMAP_WEB_SERVICE_KEY: "" }),
			classification: "KEY_MISSING",
		},
		{
			name: "the signing private key is absent",
			confirmLiveRequest: true,
			env: enabledEnv({ AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "" }),
			classification: "SIGNATURE_PRIVATE_KEY_MISSING",
		},
		{
			name: "the IP whitelist has not been confirmed",
			confirmLiveRequest: true,
			env: enabledEnv({ AMAP_IP_WHITELIST_CONFIGURED: "false" }),
			classification: "IP_WHITELIST_NOT_CONFIRMED",
		},
	] as const)(
		"makes zero network calls when $name",
		async ({ confirmLiveRequest, env, classification }) => {
			const fetchMock = vi.fn();
			const error = await runAmapLiveSmoke({
				env,
				confirmLiveRequest,
				fetchImpl: fetchMock as typeof fetch,
			}).catch((caught) => caught);

			expect(safeAmapLiveSmokeFailure(error)).toEqual({
				ok: false,
				chain: "GATE",
				classification,
				safeInfocode: "UNKNOWN",
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("performs exactly the three expected provider calls and emits only counts", async () => {
		const observedPaths: string[] = [];
		const result = await runAmapLiveSmoke({
			env: enabledEnv(),
			confirmLiveRequest: true,
			fetchImpl: successfulAmapFetch(observedPaths),
		});

		expect(observedPaths).toEqual([
			"/v5/place/text",
			"/v5/place/around",
			"/v5/place/around",
		]);
		expect(result).toEqual({
			ok: true,
			chains: [
				{ chain: "LOCATION_TEXT", resultCount: 1 },
				{ chain: "PLACE_KEYWORD", resultCount: 1 },
				{ chain: "RECOMMENDATION_RECALL", resultCount: 1 },
			],
		});
		const output = JSON.stringify(result);
		for (const privateValue of [
			"private-live-smoke-key",
			"固定测试地点",
			"固定测试餐厅",
			"固定测试地址",
			"PRIVATE-UPSTREAM-POI-ID",
			"116.310900",
		]) {
			expect(output).not.toContain(privateValue);
		}
	});

	it("stops after a classified rejection and never emits upstream details", async () => {
		const privateInfo = "private-live-smoke-key 北京大学 116.310900,39.992800";
		let callCount = 0;
		const error = await runAmapLiveSmoke({
			env: enabledEnv(),
			confirmLiveRequest: true,
			fetchImpl: async () => {
				callCount += 1;
				return new Response(
					JSON.stringify({
						status: "0",
						infocode: "10005",
						info: privateInfo,
					}),
					{ status: 200 },
				);
			},
		}).catch((caught) => caught);

		const output = JSON.stringify(safeAmapLiveSmokeFailure(error));
		expect(JSON.parse(output)).toEqual({
			ok: false,
			chain: "LOCATION_TEXT",
			classification: "CONFIGURATION_OR_PERMISSION",
			safeInfocode: "10005",
		});
		expect(callCount).toBe(1);
		expect(output).not.toContain(privateInfo);
		expect(output).not.toContain("private-live-smoke-key");
		expect(output).not.toContain("116.310900");
	});

	it("discards a low-level error containing the complete sensitive URL", async () => {
		const error = await runAmapLiveSmoke({
			env: enabledEnv(),
			confirmLiveRequest: true,
			fetchImpl: async (input) => {
				throw new Error(`socket failure ${String(input)}`);
			},
		}).catch((caught) => caught);

		const output = JSON.stringify(safeAmapLiveSmokeFailure(error));
		expect(JSON.parse(output)).toMatchObject({
			ok: false,
			chain: "LOCATION_TEXT",
			classification: "NETWORK_ERROR",
		});
		for (const privateValue of [
			"private-live-smoke-key",
			"北京大学",
			"restapi.amap.com",
		]) {
			expect(output).not.toContain(privateValue);
		}
	});
});
