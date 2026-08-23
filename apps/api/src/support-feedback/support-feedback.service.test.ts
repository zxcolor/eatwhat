import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUserResolver } from "../auth/authenticated-user.resolver.js";
import type {
	SupportFeedbackInsert,
	SupportFeedbackInsertResult,
	SupportFeedbackRepository,
	SupportFeedbackRequiredKeyVersion,
} from "./support-feedback.repository.js";
import { SupportFeedbackQuotaExceededError } from "./support-feedback.repository.js";
import {
	normalizeClientIp,
	normalizeMessage,
	SupportFeedbackService,
} from "./support-feedback.service.js";
import type { SupportFeedbackRuntimeConfig } from "./support-feedback-config.js";
import {
	decryptSupportFeedback,
	SupportFeedbackKeyRing,
} from "./support-feedback-crypto.js";

function encryptionKeyRing() {
	return new SupportFeedbackKeyRing(
		"enc-v1",
		new Map([["enc-v1", Buffer.alloc(32, 19)]]),
	);
}

function hmacKeyRing() {
	return new SupportFeedbackKeyRing(
		"hmac-v2",
		new Map([
			["hmac-v1", Buffer.alloc(32, 20)],
			["hmac-v2", Buffer.alloc(32, 21)],
		]),
	);
}

function buildService(options?: {
	readonly enabled?: boolean;
	readonly userId?: string;
	readonly insert?: (
		input: SupportFeedbackInsert,
	) => Promise<SupportFeedbackInsertResult>;
	readonly requiredKeys?: readonly SupportFeedbackRequiredKeyVersion[];
}) {
	const encryptionRing = encryptionKeyRing();
	const hmacRing = hmacKeyRing();
	const enabled = options?.enabled ?? true;
	const config: SupportFeedbackRuntimeConfig = Object.freeze({
		enabled,
		encryptionKeyRing: enabled ? encryptionRing : null,
		hmacKeyRing: enabled ? hmacRing : null,
	});
	const insert = vi.fn(
		options?.insert ??
			(async (_input: SupportFeedbackInsert) => ({
				kind: "INSERTED" as const,
			})),
	);
	const requiredKeyVersions = vi.fn(
		async () =>
			options?.requiredKeys ?? [
				{ purpose: "ENCRYPTION", keyVersion: "enc-v1", recordCount: 1 },
				{ purpose: "HMAC", keyVersion: "hmac-v1", recordCount: 1 },
			],
	);
	const repository = {
		isAvailable: () => true,
		insert,
		requiredKeyVersions,
	} as unknown as SupportFeedbackRepository;
	const resolveAuthorization = vi.fn(async () => ({
		userId: options?.userId ?? randomUUID(),
		sessionId: randomUUID(),
		deviceHash: "a".repeat(64),
	}));
	const resolver = {
		resolveAuthorization,
	} as unknown as AuthenticatedUserResolver;
	return {
		encryptionRing,
		hmacRing,
		insert,
		requiredKeyVersions,
		resolveAuthorization,
		service: new SupportFeedbackService(config, repository, resolver),
	};
}

async function buildReadyService(
	options?: Parameters<typeof buildService>[0],
) {
	const fixture = buildService(options);
	await fixture.service.onApplicationBootstrap();
	return fixture;
}

describe("SupportFeedbackService", () => {
	it("accepts a guest, encrypts content, and stores only versioned IP HMACs", async () => {
		let captured: SupportFeedbackInsert | null = null;
		const fixture = await buildReadyService({
			insert: async (input) => {
				captured = { ...input, ciphertext: Buffer.from(input.ciphertext) };
				return { kind: "INSERTED" };
			},
		});
		const submissionId = randomUUID();
		const response = await fixture.service.submit(
			{
				submissionId,
				category: "PLACE_CORRECTION",
				message: "  这家餐厅现在晚上八点停止营业。  ",
			},
			undefined,
			"::ffff:127.0.0.1",
		);

		expect(response).toEqual({
			feedbackId: submissionId,
			accepted: true,
			retentionAfterClosureDays: 180,
		});
		expect(fixture.resolveAuthorization).not.toHaveBeenCalled();
		const saved = captured as unknown as SupportFeedbackInsert;
		expect(saved.submitterKind).toBe("GUEST");
		expect(saved.userId).toBeNull();
		expect(saved.ciphertext.toString("utf8")).not.toContain("餐厅");
		expect(saved.contentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
		expect(saved.contentFingerprintCandidates).toHaveProperty("hmac-v1");
		expect(saved.guestIpHash).toMatch(/^[0-9a-f]{64}$/u);
		expect(JSON.stringify(saved)).not.toContain("127.0.0.1");
		expect(
			decryptSupportFeedback(
				saved.ciphertext,
				saved.encryptionKeyVersion,
				{
					feedbackId: submissionId,
					category: "PLACE_CORRECTION",
				},
				fixture.encryptionRing,
			),
		).toBe("这家餐厅现在晚上八点停止营业。");
	});

	it("binds a bearer submission to the account quota scope only", async () => {
		const userId = randomUUID();
		const fixture = await buildReadyService({ userId });
		await fixture.service.submit(
			{
				submissionId: randomUUID(),
				category: "PRIVACY",
				message: "请说明账号数据导出的处理范围。",
			},
			"Bearer opaque",
			"198.51.100.8",
		);
		expect(fixture.resolveAuthorization).toHaveBeenCalledWith("Bearer opaque");
		expect(fixture.insert.mock.calls[0]?.[0]).toMatchObject({
			userId,
			submitterKind: "ACCOUNT",
			guestIpHash: null,
			guestIpHashCandidates: null,
		});
	});

	it("never downgrades a supplied invalid bearer to a guest submission", async () => {
		const fixture = await buildReadyService();
		fixture.resolveAuthorization.mockRejectedValueOnce(
			new HttpException(
				{ code: "SESSION_EXPIRED", message: "身份验证失败或会话已失效" },
				401,
			),
		);
		await expect(
			fixture.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRIVACY",
					message: "这是携带无效登录凭据的反馈提交。",
				},
				"Bearer expired-token",
				"198.51.100.8",
			),
		).rejects.toMatchObject({ status: 401 });
		expect(fixture.insert).not.toHaveBeenCalled();
	});

	it("maps an unavailable optional-auth channel to the feedback-safe 503", async () => {
		const fixture = await buildReadyService();
		fixture.resolveAuthorization.mockRejectedValueOnce(
			new HttpException(
				{
					code: "AUTH_CHANNEL_UNAVAILABLE",
					message: "private auth configuration detail",
				},
				503,
			),
		);
		let caught: unknown;
		try {
			await fixture.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "这是认证通道不可用时的反馈提交。",
				},
				"Bearer structurally-valid-token",
				"198.51.100.8",
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HttpException);
		expect((caught as HttpException).getResponse()).toEqual({
			code: "SUPPORT_FEEDBACK_UNAVAILABLE",
			message: "反馈服务暂时不可用，请稍后重试",
		});
		expect(fixture.insert).not.toHaveBeenCalled();
	});

	it("fails closed without leaking repository or source-address errors", async () => {
		const disabled = buildService({ enabled: false });
		await expect(
			disabled.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "这是足够长的有效反馈内容。",
				},
				undefined,
				"127.0.0.1",
			),
		).rejects.toMatchObject({ status: 503 });

		const failing = await buildReadyService({
			insert: async () => {
				throw new Error("postgres secret detail");
			},
		});
		let error: unknown;
		try {
			await failing.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "这是足够长的有效反馈内容。",
				},
				undefined,
				"127.0.0.1",
			);
		} catch (candidate) {
			error = candidate;
		}
		expect(error).toBeInstanceOf(HttpException);
		expect(
			JSON.stringify((error as HttpException).getResponse()),
		).not.toContain("postgres");

		const invalidSource = await buildReadyService();
		await expect(
			invalidSource.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "这是来源地址无法验证时的反馈内容。",
				},
				undefined,
				"not-an-ip",
			),
		).rejects.toMatchObject({ status: 503 });
		expect(invalidSource.insert).not.toHaveBeenCalled();
	});

	it("normalizes messages and trusted proxy IP forms", () => {
		expect(normalizeMessage("  第一行\r\n第二行内容足够长  ")).toBe(
			"第一行\n第二行内容足够长",
		);
		expect(() => normalizeMessage("太短")).toThrow();
		expect(() => normalizeMessage(`有效正文但是含有\u0000控制符`)).toThrow();
		expect(() => normalizeMessage("好".repeat(2_001))).toThrow();
		expect(normalizeClientIp(" ::FFFF:192.0.2.1 ")).toBe("192.0.2.1");
		expect(normalizeClientIp("2001:db8::1")).toBe("2001:db8::1");
		expect(normalizeClientIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
		expect(normalizeClientIp("0:0:0:0:0:ffff:c000:201")).toBe("192.0.2.1");
		expect(normalizeClientIp("unknown")).toBeNull();
	});

	it("canonicalizes UUID case before encryption, persistence, and response", async () => {
		let captured: SupportFeedbackInsert | null = null;
		const fixture = await buildReadyService({
			insert: async (input) => {
				captured = input;
				return { kind: "INSERTED" };
			},
		});
		const uppercaseId = randomUUID().toUpperCase();
		const response = await fixture.service.submit(
			{
				submissionId: uppercaseId,
				category: "PRODUCT",
				message: "这是用于验证 UUID 大小写归一化的反馈。",
			},
			undefined,
			"127.0.0.1",
		);
		expect(response.feedbackId).toBe(uppercaseId.toLowerCase());
		expect((captured as unknown as SupportFeedbackInsert).feedbackId).toBe(
			uppercaseId.toLowerCase(),
		);
	});

	it("zeroes transient ciphertext after the atomic call", async () => {
		let transient: Buffer | null = null;
		const fixture = await buildReadyService({
			insert: async (input) => {
				transient = input.ciphertext;
				return { kind: "INSERTED" };
			},
		});
		await fixture.service.submit(
			{
				submissionId: randomUUID(),
				category: "COMPLAINT",
				message: "这是足够长的投诉反馈内容。",
			},
			undefined,
			"127.0.0.1",
		);
		expect((transient as unknown as Buffer).every((byte) => byte === 0)).toBe(
			true,
		);
	});

	it("accepts an exact replay and rejects a database mismatch", async () => {
		const replay = await buildReadyService({
			insert: async () => ({ kind: "REPLAY" }),
		});
		await expect(
			replay.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "这是同一条会被安全重试的反馈内容。",
				},
				undefined,
				"127.0.0.1",
			),
		).resolves.toMatchObject({ accepted: true });

		const mismatch = await buildReadyService({
			insert: async () => ({ kind: "MISMATCH" }),
		});
		await expect(
			mismatch.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "这是被错误复用同一个标识的另一条反馈。",
				},
				undefined,
				"127.0.0.1",
			),
		).rejects.toMatchObject({ status: 409 });
	});

	it("maps the durable quota gate to a generic 429", async () => {
		const fixture = await buildReadyService({
			insert: async () => {
				throw new SupportFeedbackQuotaExceededError();
			},
		});
		await expect(
			fixture.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "这是超过持久化日配额后的反馈内容。",
				},
				undefined,
				"127.0.0.1",
			),
		).rejects.toMatchObject({ status: 429 });
	});

	it("fails startup when retained rows outlive configured keys or need migration", async () => {
		const covered = buildService();
		expect(covered.service.isReady()).toBe(false);
		await expect(
			covered.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "启动覆盖检查完成前不得接受这条反馈。",
				},
				undefined,
				"127.0.0.1",
			),
		).rejects.toMatchObject({ status: 503 });
		expect(covered.insert).not.toHaveBeenCalled();
		await expect(
			covered.service.onApplicationBootstrap(),
		).resolves.toBeUndefined();
		expect(covered.service.isReady()).toBe(true);

		const missing = buildService({
			requiredKeys: [
				{ purpose: "ENCRYPTION", keyVersion: "enc-old", recordCount: 1 },
			],
		});
		await expect(missing.service.onApplicationBootstrap()).rejects.toThrow(
			"enc-old",
		);
		expect(missing.service.isReady()).toBe(false);
		expect(() => missing.encryptionRing.versions()).toThrow("已销毁");
		expect(() => missing.hmacRing.versions()).toThrow("已销毁");

		const legacy = buildService({
			requiredKeys: [{ purpose: "LEGACY", keyVersion: null, recordCount: 1 }],
		});
		await expect(legacy.service.onApplicationBootstrap()).rejects.toThrow(
			"旧版记录",
		);
		expect(legacy.service.isReady()).toBe(false);

		const disabled = buildService({ enabled: false });
		await disabled.service.onApplicationBootstrap();
		expect(disabled.service.isReady()).toBe(false);

		covered.service.onApplicationShutdown();
		expect(covered.service.isReady()).toBe(false);
		await expect(
			covered.service.submit(
				{
					submissionId: randomUUID(),
					category: "PRODUCT",
					message: "服务关闭后不得接受这条反馈。",
				},
				undefined,
				"127.0.0.1",
			),
		).rejects.toMatchObject({ status: 503 });
	});
});
