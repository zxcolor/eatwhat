import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import {
	FeatureConfigSchema,
	SupportFeedbackResponseSchema,
} from "@chi-shen-me/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";
import { configureHttpRuntime } from "../common/http-runtime-security.js";
import { SafeExceptionFilter } from "../common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "../config/app-config.js";
import { createStandalonePool } from "../database/standalone-pool.js";

const POSTGRES_E2E_ENABLED =
	process.env.SUPPORT_FEEDBACK_POSTGRES_E2E === "true";
const describePostgres = POSTGRES_E2E_ENABLED
	? describe.sequential
	: describe.skip;
const E2E_ENCRYPTION_KEY_VERSION = "e2e-enc-v1";
const E2E_HMAC_KEY_VERSION = "e2e-hmac-v1";
const ENVIRONMENT_KEYS = [
	"SUPPORT_FEEDBACK_ENABLED",
	"SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION",
	"SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON",
	"SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION",
	"SUPPORT_FEEDBACK_HMAC_KEYS_JSON",
] as const;

describePostgres("support feedback PostgreSQL HTTP flow", () => {
	let app: INestApplication | null = null;
	let baseUrl = "";
	let cleanupDatabaseUrl = "";
	let environmentCaptured = false;
	const originalEnvironment = new Map<string, string | undefined>();

	beforeAll(async () => {
		for (const key of ENVIRONMENT_KEYS) {
			originalEnvironment.set(key, process.env[key]);
		}
		environmentCaptured = true;
		const databaseUrl =
			process.env.SUPPORT_FEEDBACK_POSTGRES_E2E_DATABASE_URL?.trim() ?? "";
		if (databaseUrl.length === 0) {
			throw new Error(
				"SUPPORT_FEEDBACK_POSTGRES_E2E_DATABASE_URL is required for the opted-in test",
			);
		}
		cleanupDatabaseUrl =
			process.env.SUPPORT_FEEDBACK_POSTGRES_E2E_CLEANUP_DATABASE_URL?.trim() ??
			"";
		if (cleanupDatabaseUrl.length === 0) {
			throw new Error(
				"SUPPORT_FEEDBACK_POSTGRES_E2E_CLEANUP_DATABASE_URL is required for the opted-in test",
			);
		}
		// A prior interrupted local run must not strand rows encrypted with random
		// one-run keys. The cleanup credential is deliberately separate from the
		// runtime role exercised by the application.
		await cleanupE2eRows(cleanupDatabaseUrl);
		const encryptionKey = randomBytes(32);
		let hmacKey = randomBytes(32);
		while (hmacKey.equals(encryptionKey)) {
			hmacKey.fill(0);
			hmacKey = randomBytes(32);
		}
		try {
			process.env.SUPPORT_FEEDBACK_ENABLED = "true";
			process.env.SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION =
				E2E_ENCRYPTION_KEY_VERSION;
			process.env.SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON = JSON.stringify({
				[E2E_ENCRYPTION_KEY_VERSION]: encryptionKey.toString("base64"),
			});
			process.env.SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION = E2E_HMAC_KEY_VERSION;
			process.env.SUPPORT_FEEDBACK_HMAC_KEYS_JSON = JSON.stringify({
				[E2E_HMAC_KEY_VERSION]: hmacKey.toString("base64"),
			});
		} finally {
			encryptionKey.fill(0);
			hmacKey.fill(0);
		}

		app = await startApp(databaseUrl);
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		try {
			if (app !== null) await app.close();
		} finally {
			try {
				if (cleanupDatabaseUrl.length > 0) {
					await cleanupE2eRows(cleanupDatabaseUrl);
				}
			} finally {
				if (environmentCaptured) {
					for (const key of ENVIRONMENT_KEYS) {
						const previous = originalEnvironment.get(key);
						if (previous === undefined) delete process.env[key];
						else process.env[key] = previous;
					}
				}
			}
		}
	});

	it("advertises readiness and accepts an idempotent guest place correction", async () => {
		const configResponse = await fetch(`${baseUrl}/v1/config`);
		const config = FeatureConfigSchema.parse(await configResponse.json());
		expect(configResponse.status).toBe(200);
		expect(config.supportFeedbackEnabled).toBe(true);

		const submissionId = randomUUID();
		const payload = {
			submissionId,
			category: "PLACE_CORRECTION",
			message: "餐厅门牌地址有误，请核对并更新当前展示地址。",
		} as const;
		const first = await submit(payload);
		expect(first.response.status).toBe(202);
		expect(SupportFeedbackResponseSchema.parse(first.body)).toEqual({
			feedbackId: submissionId,
			accepted: true,
			retentionAfterClosureDays: 180,
		});

		const replay = await submit(payload);
		expect(replay.response.status).toBe(202);
		expect(replay.body).toEqual(first.body);

		const mismatch = await submit({
			...payload,
			message: "同一提交标识不得改成另一条餐厅纠错内容。",
		});
		expect(mismatch.response.status).toBe(409);
		expect(mismatch.body).toMatchObject({
			code: "SUPPORT_FEEDBACK_IDEMPOTENCY_CONFLICT",
		});
	});

	it("enforces the database-backed guest quota", async () => {
		// The preceding INSERT counts once; its replay and mismatch do not consume quota.
		for (let index = 2; index <= 5; index += 1) {
			const accepted = await submit({
				submissionId: randomUUID(),
				category: "PLACE_CORRECTION",
				message: `第 ${index} 条独立餐厅纠错用于验证游客配额边界。`,
			});
			expect(accepted.response.status).toBe(202);
		}

		const limited = await submit({
			submissionId: randomUUID(),
			category: "PLACE_CORRECTION",
			message: "第六条餐厅纠错应由数据库配额原子拒绝。",
		});
		expect(limited.response.status).toBe(429);
		expect(limited.body).toMatchObject({
			code: "SUPPORT_FEEDBACK_RATE_LIMITED",
		});
	});

	it("stops advertising and fails closed after a disabled restart", async () => {
		if (app === null)
			throw new Error("enabled test application is unavailable");
		await app.close();
		app = null;
		process.env.SUPPORT_FEEDBACK_ENABLED = "false";
		delete process.env.SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION;
		delete process.env.SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON;
		delete process.env.SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION;
		delete process.env.SUPPORT_FEEDBACK_HMAC_KEYS_JSON;

		const databaseUrl =
			process.env.SUPPORT_FEEDBACK_POSTGRES_E2E_DATABASE_URL?.trim() ?? "";
		app = await startApp(databaseUrl);
		baseUrl = await app.getUrl();

		const configResponse = await fetch(`${baseUrl}/v1/config`);
		const config = FeatureConfigSchema.parse(await configResponse.json());
		expect(config.supportFeedbackEnabled).toBe(false);

		const privateMessage = "这段关闭态纠错正文不得出现在错误响应中。";
		const rejected = await submit({
			submissionId: randomUUID(),
			category: "PLACE_CORRECTION",
			message: privateMessage,
		});
		expect(rejected.response.status).toBe(503);
		expect(rejected.body).toMatchObject({
			code: "SUPPORT_FEEDBACK_UNAVAILABLE",
		});
		expect(JSON.stringify(rejected.body)).not.toContain(privateMessage);
	});

	async function submit(payload: {
		readonly submissionId: string;
		readonly category: "PLACE_CORRECTION";
		readonly message: string;
	}): Promise<{ response: Response; body: Record<string, unknown> }> {
		const response = await fetch(`${baseUrl}/v1/support-feedback`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		return {
			response,
			body: (await response.json()) as Record<string, unknown>,
		};
	}
});

async function startApp(databaseUrl: string): Promise<INestApplication> {
	const module = await Test.createTestingModule({ imports: [AppModule] })
		.overrideProvider(APP_CONFIG)
		.useValue(
			loadAppConfig({
				NODE_ENV: "test",
				DATABASE_ENABLED: "true",
				DATABASE_URL: databaseUrl,
				DATABASE_SSL_MODE: "disable",
				AUTH_SCHEMA_TRANSITION_MODE: "none",
				ALLOW_DEMO_DATA: "true",
				AMAP_ENABLED: "false",
				QWEN_ENABLED: "false",
			}),
		)
		.compile();
	const app = module.createNestApplication({ bodyParser: false });
	app.useGlobalFilters(new SafeExceptionFilter());
	configureHttpRuntime(app, app.get(APP_CONFIG));
	await app.listen(0, "127.0.0.1");
	return app;
}

async function cleanupE2eRows(databaseUrl: string): Promise<void> {
	const pool = createStandalonePool(
		databaseUrl,
		false,
		"chi-shen-me-support-feedback-e2e-cleanup",
	);
	try {
		await pool.query(
			`DELETE FROM public.support_feedback
			 WHERE encryption_key_version = $1
			   AND content_fingerprint_key_version = $2`,
			[E2E_ENCRYPTION_KEY_VERSION, E2E_HMAC_KEY_VERSION],
		);
	} finally {
		await pool.end();
	}
}
