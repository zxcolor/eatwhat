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
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { AuthAvailabilityGuard } from "./auth-availability.guard.js";
import { AuthRateLimitInterceptor } from "./auth-rate-limit.interceptor.js";

describe("disabled account HTTP boundary", () => {
	let app: INestApplication;
	let baseUrl: string;
	let retiredApp: INestApplication;
	let retiredBaseUrl: string;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					ACCOUNTS_ENABLED: "false",
					DATABASE_ENABLED: "false",
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

		const retiredModule = await Test.createTestingModule({
			controllers: [AuthController],
			providers: [
				{ provide: AuthService, useValue: {} },
				{ provide: APP_CONFIG, useValue: { auth: { enabled: true } } },
				{
					provide: AuthAvailabilityGuard,
					useValue: { canActivate: () => true },
				},
				{
					provide: AuthRateLimitInterceptor,
					useValue: {
						intercept: (_context: unknown, next: { handle(): unknown }) =>
							next.handle(),
					},
				},
			],
		}).compile();
		retiredApp = retiredModule.createNestApplication();
		await retiredApp.listen(0, "127.0.0.1");
		retiredBaseUrl = await retiredApp.getUrl();
	});

	afterAll(async () => {
		await app.close();
		if (retiredApp !== undefined) await retiredApp.close();
	});

	it.each([
		["POST", "/v1/auth/phone/request-code"],
		["POST", "/v1/auth/email/request-code"],
		["POST", "/v1/auth/oauth/state"],
		["POST", "/v1/auth/login"],
		["POST", "/v1/auth/refresh"],
		["POST", "/v1/auth/logout"],
		["GET", "/v1/auth/identities"],
		["POST", "/v1/auth/identities"],
		["DELETE", "/v1/auth/identities/2af305ae-82a1-4f87-86b7-1c97c4a8683f"],
		["GET", "/v1/auth/sessions"],
		["DELETE", "/v1/auth/sessions/2af305ae-82a1-4f87-86b7-1c97c4a8683f"],
		["POST", "/v1/account/export"],
		["GET", "/v1/account/exports/latest"],
		["GET", "/v1/account/exports/2af305ae-82a1-4f87-86b7-1c97c4a8683f"],
		["GET", "/v1/account/exports/2af305ae-82a1-4f87-86b7-1c97c4a8683f/content"],
		["DELETE", "/v1/account"],
	] as const)(
		"%s %s always fails closed before parsing",
		async (method, path) => {
			const sensitive = "phone@example.com token-code-state-subject";
			const response = await fetch(`${baseUrl}${path}`, {
				method,
				headers: {
					"content-type": "text/plain",
					authorization: `Bearer ${"A".repeat(43)}`,
					"x-request-id": sensitive,
				},
				body: method === "GET" ? undefined : sensitive,
			});
			const text = await response.text();
			const body = JSON.parse(text) as Record<string, unknown>;

			expect(response.status).toBe(503);
			expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
				CURRENT_CONTRACT_VERSION,
			);
			expect(body).toMatchObject({
				code: "AUTH_CHANNEL_UNAVAILABLE",
				message: "该账号能力暂未开放或暂时不可用",
			});
			expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/iu);
			expect(text).not.toContain(sensitive);
			expect(text).not.toContain("A".repeat(43));
		},
	);

	it.each([
		["POST", "/v1/auth/phone/fusion-token"],
		["POST", "/v1/auth/phone/fusion-verify"],
		["POST", "/v1/auth/register/phone-wechat"],
		["POST", "/v1/auth/register/fusion-wechat"],
	] as const)("%s %s stays retired", async (method, path) => {
		const response = await fetch(`${retiredBaseUrl}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(404);
	});

	it("leaves existing public capabilities operational", async () => {
		const [health, config] = await Promise.all([
			fetch(`${baseUrl}/health`),
			fetch(`${baseUrl}/v1/config`),
		]);
		expect(health.status).toBe(200);
		expect(config.status).toBe(200);
		await expect(config.json()).resolves.toMatchObject({
			accountsEnabled: false,
			authCapabilities: {
				accountsEnabled: false,
				registrationEnabled: false,
				phoneEnabled: false,
				wechatEnabled: false,
				emailEnabled: false,
				qqEnabled: false,
			},
		});
	});
});
