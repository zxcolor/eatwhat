import "reflect-metadata";
import {
	FeatureConfigSchema,
	GroupRecommendationResponseSchema,
} from "@chi-shen-me/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "./app.module.js";
import { configureHttpRuntime } from "./common/http-runtime-security.js";
import { RecommendationRequestRegistry } from "./common/recommendation-request.registry.js";
import { SafeExceptionFilter } from "./common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "./config/app-config.js";
import { QWEN_FETCH } from "./recommendations/providers/qwen-intent.provider.js";

const validBody = Object.freeze({
	location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
	travelMode: "WALK",
	members: [
		{
			budgetMaxYuan: null,
			availableMinutes: 60,
			radiusMeters: 1_500,
			preferredCuisines: ["面食"],
			excludedCuisines: [],
		},
		{
			budgetMaxYuan: 40,
			availableMinutes: 45,
			radiusMeters: 900,
			preferredCuisines: [],
			excludedCuisines: ["火锅"],
		},
	],
});

describe("anonymous same-device group recommendation HTTP boundary", () => {
	let app: INestApplication;
	let baseUrl: string;
	const qwenFetch = vi.fn();

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					GROUP_RECOMMENDATIONS_ENABLED: "true",
					QWEN_ENABLED: "true",
					QWEN_BASE_URL:
						"https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
					QWEN_API_KEY: "test-only-key",
				}),
			)
			.overrideProvider(QWEN_FETCH)
			.useValue(qwenFetch)
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app.close();
	});

	it("advertises the enabled capability only with a concrete provider plan", async () => {
		const response = await fetch(`${baseUrl}/v1/config`);
		const config = FeatureConfigSchema.parse(await response.json());
		expect(response.status).toBe(200);
		expect(config.serviceCapabilities).toMatchObject({
			recommendationsEnabled: true,
			groupRecommendationsEnabled: true,
		});
	});

	it("returns display-only results without Qwen or result-token registry state", async () => {
		const registry = app.get(RecommendationRequestRegistry);
		const before = registry.diagnostics();
		const response = await fetch(`${baseUrl}/v1/group-recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(validBody),
		});
		const raw = await response.json();
		const parsed = GroupRecommendationResponseSchema.safeParse(raw);

		expect(response.status).toBe(200);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.aggregation).toMatchObject({
			memberCount: 2,
			effectiveBudgetMaxYuan: 40,
			effectiveAvailableMinutes: 45,
			effectiveRadiusMeters: 900,
			preferredCuisines: ["面食"],
			excludedCuisines: ["火锅"],
		});
		expect(parsed.data.dataRightsMode).toBe("LIVE_DISPLAY_ONLY");
		expect(parsed.data.results).toHaveLength(3);
		expect(
			parsed.data.results.every((result) => result.fitScore === null),
		).toBe(true);
		expect(qwenFetch).not.toHaveBeenCalled();
		expect(registry.diagnostics()).toEqual(before);
		expect(JSON.stringify(raw)).not.toMatch(
			/resultToken|providerPlaceId|actions|location|phone|imageUrl|aiAssisted|promptVersion|modelVersion|aiFallbackUsed|Authorization/u,
		);
	});

	it.each([
		["one member", { ...validBody, members: validBody.members.slice(0, 1) }],
		[
			"nine members",
			{
				...validBody,
				members: Array.from({ length: 9 }, () => validBody.members[0]),
			},
		],
		["top-level free text", { ...validBody, note: "private free text" }],
		[
			"member name",
			{
				...validBody,
				members: [
					{ ...validBody.members[0], name: "private member name" },
					validBody.members[1],
				],
			},
		],
		[
			"member location",
			{
				...validBody,
				members: [
					{
						...validBody.members[0],
						location: { latitude: 39.9, longitude: 116.4 },
					},
					validBody.members[1],
				],
			},
		],
		[
			"member preference-exclusion overlap",
			{
				...validBody,
				members: [
					{
						...validBody.members[0],
						excludedCuisines: ["面食"],
					},
					validBody.members[1],
				],
			},
		],
	] as const)("strictly rejects %s", async (_label, body) => {
		const response = await fetch(`${baseUrl}/v1/group-recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const problem = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(400);
		expect(problem.code).toBe("INVALID_REQUEST");
		expect(JSON.stringify(problem)).not.toMatch(
			/private free text|private member name|39\.9|116\.4/u,
		);
	});
});

describe("anonymous group recommendation rate limit boundary", () => {
	let app: INestApplication;
	let baseUrl: string;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					GROUP_RECOMMENDATIONS_ENABLED: "true",
				}),
			)
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app.close();
	});

	it("accepts exactly ten requests per minute and rejects the eleventh", async () => {
		for (let index = 0; index < 10; index += 1) {
			const response = await fetch(`${baseUrl}/v1/group-recommendations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(validBody),
			});
			expect(response.status, `request ${index + 1}`).toBe(200);
		}

		const limited = await fetch(`${baseUrl}/v1/group-recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(validBody),
		});
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(
			1,
		);
		await expect(limited.json()).resolves.toMatchObject({
			code: "RATE_LIMITED",
		});
	});
});
