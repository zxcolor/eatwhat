import "reflect-metadata";
import {
	CONTRACT_VERSION_HEADER,
	CURRENT_CONTRACT_VERSION,
} from "@chi-shen-me/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";
import { configureHttpRuntime } from "../common/http-runtime-security.js";
import { SafeExceptionFilter } from "../common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "../config/app-config.js";

describe("public readiness failure boundary", () => {
	let app: INestApplication;
	let baseUrl: string;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					ALLOW_DEMO_DATA: "false",
					AMAP_ENABLED: "false",
					QWEN_ENABLED: "false",
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

	it("keeps liveness healthy while readiness returns one sanitized 503", async () => {
		const [liveResponse, readyResponse] = await Promise.all([
			fetch(`${baseUrl}/health`),
			fetch(`${baseUrl}/health/ready`),
		]);
		const liveBody = (await liveResponse.json()) as Record<string, unknown>;
		const readyBody = (await readyResponse.json()) as Record<string, unknown>;

		expect(liveResponse.status).toBe(200);
		expect(liveBody.status).toBe("ok");
		expect(readyResponse.status).toBe(503);
		expect(readyResponse.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
		expect(readyBody).toMatchObject({
			code: "SERVICE_NOT_READY",
			message: "服务尚未就绪，请稍后重试",
		});
		expect(String(readyBody.requestId)).toMatch(/^[0-9a-f-]{36}$/iu);
		expect(JSON.stringify(readyBody)).not.toMatch(
			/database|postgres|AMAP|provider|credential|secret/iu,
		);
	});

	it("advertises every core service capability as disabled", async () => {
		const response = await fetch(`${baseUrl}/v1/config`);
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			serviceCapabilities: {
				recommendationsEnabled: false,
				locationSearchEnabled: false,
				placeSearchEnabled: false,
			},
		});
		expect(JSON.stringify(body)).not.toMatch(
			/AMAP_WEB_SERVICE_KEY|credential|secret/iu,
		);
	});
});
