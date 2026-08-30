import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyAdminRequest } from "./admin-bff";
import {
	ADMIN_CONTRACT_HEADER,
	ADMIN_CONTRACT_VERSION,
} from "./admin-contract";

const SESSION_TOKEN = "s".repeat(43);
const DEVICE_TOKEN = "d".repeat(43);
const UPDATE_BODY = {
	expectedActiveVersion: 1,
	value: { enabled: true },
	changeReason: "ROUTINE_TUNING",
} as const;

const aiConfigRecord = {
	configKey: "features.ai-assistance",
	configSchema: "FEATURE_FLAGS_V1",
	classification: "PUBLIC",
	version: 2,
	value: { enabled: true },
	changeReason: "ROUTINE_TUNING",
	createdAt: "2026-08-30T01:00:00.000Z",
	activatedAt: "2026-08-30T01:00:00.000Z",
} as const;

const coverageConfigRecord = {
	configKey: "coverage.default",
	configSchema: "COVERAGE_SETTINGS_V1",
	classification: "PUBLIC",
	version: 2,
	value: {
		defaultRadiusMeters: 1_500,
		maximumRadiusMeters: 10_000,
		areaCode: "NATIONWIDE",
	},
	changeReason: "ROUTINE_TUNING",
	createdAt: "2026-08-30T01:00:00.000Z",
	activatedAt: "2026-08-30T01:00:00.000Z",
} as const;

interface RequestOptions {
	body?: string;
	csrf?: "valid" | "missing-ui-header" | "cross-site" | "foreign-origin";
	includeContentLength?: boolean;
	method?: string;
	session?: boolean;
}

function requestFor(pathAndQuery: string, options: RequestOptions = {}) {
	const method = options.method ?? "GET";
	const path = pathAndQuery.split("?", 1)[0] ?? "";
	const headers = new Headers({ Host: "localhost" });
	if (options.session !== false) {
		headers.set(
			"Cookie",
			`chishenme_admin_loopback=${SESSION_TOKEN}; chishenme_admin_device_loopback=${DEVICE_TOKEN}`,
		);
	}
	if (options.body !== undefined) {
		headers.set("Content-Type", "application/json; charset=utf-8");
		if (options.includeContentLength !== false) {
			headers.set("Content-Length", String(Buffer.byteLength(options.body)));
		}
	}
	if (method !== "GET" && options.csrf !== "missing-ui-header") {
		headers.set("X-ChiShenMe-Admin-Ui", "1");
	}
	if (method !== "GET") {
		headers.set(
			"Sec-Fetch-Site",
			options.csrf === "cross-site" ? "cross-site" : "same-origin",
		);
		headers.set(
			"Origin",
			options.csrf === "foreign-origin"
				? "https://attacker.example"
				: "http://localhost",
		);
	}
	return {
		request: new NextRequest(`http://localhost/api/admin/${pathAndQuery}`, {
			method,
			headers,
			...(options.body === undefined ? {} : { body: options.body }),
		}),
		segments: path.split("/").filter(Boolean),
	};
}

function upstreamJson(
	payload: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json",
			[ADMIN_CONTRACT_HEADER]: ADMIN_CONTRACT_VERSION,
			...headers,
		},
	});
}

function exactJsonBytes(size: number): string {
	const empty = JSON.stringify({ padding: "" });
	const paddingSize = size - Buffer.byteLength(empty);
	if (paddingSize < 0) throw new Error("requested JSON size is too small");
	const result = JSON.stringify({ padding: "x".repeat(paddingSize) });
	if (Buffer.byteLength(result) !== size)
		throw new Error("failed to construct exact JSON size");
	return result;
}

async function call(pathAndQuery: string, options: RequestOptions = {}) {
	const { request, segments } = requestFor(pathAndQuery, options);
	return proxyAdminRequest(request, segments);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("admin BFF route allowlist", () => {
	it.each([
		["POST", "configuration", "{}"],
		["PATCH", "configuration/features.ai-assistance", "{}"],
		["GET", "configuration?debug=1", undefined],
		["GET", "configuration/unknown/history?limit=20", undefined],
		["GET", "configuration/features.ai-assistance/history?cursor=x", undefined],
		[
			"GET",
			"configuration/features.ai-assistance/history?limit=2&limit=3",
			undefined,
		],
		["GET", "audit?unknown=1", undefined],
		["GET", "audit?limit=1&limit=2", undefined],
		["GET", "session?debug=1", undefined],
	])("rejects non-allowlisted %s /%s", async (method, path, body) => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(path, {
			method,
			...(body === undefined ? {} : { body }),
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			code: "ADMIN_ROUTE_NOT_FOUND",
			message: "管理员接口不存在",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("forwards only the normalized history limit for a fixed configuration key", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			upstreamJson({ items: [] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			"configuration/features.ai-assistance/history?limit=7",
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:3002/admin/v1/configuration/features.ai-assistance/history?limit=7",
		);
	});
});

describe("admin BFF configuration projection", () => {
	it.each([
		{
			...UPDATE_BODY,
			apiSecret: "must-not-cross-the-bff",
		},
		{
			...UPDATE_BODY,
			value: { enabled: true, apiSecret: "must-not-cross-the-bff" },
		},
	])("rejects extra request JSON fields", async (payload) => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		const response = await call("configuration/features.ai-assistance", {
			method: "PUT",
			body: JSON.stringify(payload),
		});

		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(JSON.stringify(await response.json())).not.toContain(
			"must-not-cross-the-bff",
		);
	});

	it("forwards the exact validated configuration update projection", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			upstreamJson(aiConfigRecord),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call("configuration/features.ai-assistance", {
			method: "PUT",
			body: JSON.stringify(UPDATE_BODY),
		});

		expect(response.status).toBe(200);
		const init = fetchMock.mock.calls[0]?.[1];
		expect(init?.method).toBe("PUT");
		expect(JSON.parse(String(init?.body))).toEqual(UPDATE_BODY);
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${SESSION_TOKEN}`);
		expect(headers.get("x-forwarded-for")).toBe("127.0.0.1");
	});

	it("rejects an otherwise valid response for a different configuration key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => upstreamJson(coverageConfigRecord)),
		);

		const response = await call("configuration/features.ai-assistance", {
			method: "PUT",
			body: JSON.stringify(UPDATE_BODY),
		});

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			code: "ADMIN_INVALID_RESPONSE",
			message: "管理员服务返回无效",
		});
	});

	it("rejects a history response containing records from another configuration key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () =>
				upstreamJson({ items: [coverageConfigRecord] }),
			),
		);

		const response = await call(
			"configuration/features.ai-assistance/history?limit=20",
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			code: "ADMIN_INVALID_RESPONSE",
			message: "管理员服务返回无效",
		});
	});

	it("validates and projects a rollback request before forwarding it", async () => {
		const rollback = {
			expectedActiveVersion: 3,
			targetVersion: 1,
			changeReason: "ROLLBACK",
		} as const;
		const fetchMock = vi.fn<typeof fetch>(async () =>
			upstreamJson({
				...aiConfigRecord,
				version: 4,
				changeReason: "ROLLBACK",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			"configuration/features.ai-assistance/rollback",
			{
				method: "POST",
				body: JSON.stringify(rollback),
			},
		);

		expect(response.status).toBe(200);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
			rollback,
		);
	});

	it("rejects an extra rollback field before upstream fetch", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			"configuration/features.ai-assistance/rollback",
			{
				method: "POST",
				body: JSON.stringify({
					expectedActiveVersion: 3,
					targetVersion: 1,
					changeReason: "ROLLBACK",
					apiSecret: "must-not-cross-the-bff",
				}),
			},
		);

		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain("must-not-cross-the-bff");
	});

	it.each([
		{ items: [{ ...aiConfigRecord, apiSecret: "upstream-secret" }] },
		{ items: [aiConfigRecord], databasePassword: "upstream-secret" },
	])(
		"rejects extra upstream fields without reflecting them",
		async (payload) => {
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async () => upstreamJson(payload)),
			);

			const response = await call("configuration");
			const text = await response.text();

			expect(response.status).toBe(503);
			expect(text).not.toContain("upstream-secret");
			expect(JSON.parse(text)).toEqual({
				code: "ADMIN_INVALID_RESPONSE",
				message: "管理员服务返回无效",
			});
		},
	);
});

describe("admin BFF size limits", () => {
	it("accepts a JSON request at exactly 100 KiB", async () => {
		const body = exactJsonBytes(100 * 1024);
		const fetchMock = vi.fn<typeof fetch>(async () =>
			upstreamJson({ accepted: true }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call("login/options", {
			method: "POST",
			session: false,
			body,
		});

		expect(response.status).toBe(200);
		expect(Buffer.byteLength(String(fetchMock.mock.calls[0]?.[1]?.body))).toBe(
			100 * 1024,
		);
	});

	it("rejects a JSON request one byte above 100 KiB before upstream fetch", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		const response = await call("login/options", {
			method: "POST",
			session: false,
			includeContentLength: false,
			body: exactJsonBytes(100 * 1024 + 1),
		});

		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("accepts an upstream JSON response at exactly 256 KiB", async () => {
		const body = exactJsonBytes(256 * 1024);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(
				async () =>
					new Response(body, {
						headers: {
							"Content-Type": "application/json",
							[ADMIN_CONTRACT_HEADER]: ADMIN_CONTRACT_VERSION,
						},
					}),
			),
		);

		const response = await call("login/options", {
			method: "POST",
			session: false,
			body: "{}",
		});

		expect(response.status).toBe(200);
		expect((await response.json()).padding).toHaveLength(256 * 1024 - 14);
	});

	it("rejects an upstream JSON response one byte above 256 KiB", async () => {
		const body = exactJsonBytes(256 * 1024 + 1);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(
				async () =>
					new Response(body, {
						headers: {
							"Content-Type": "application/json",
							"Content-Length": String(Buffer.byteLength(body)),
							[ADMIN_CONTRACT_HEADER]: ADMIN_CONTRACT_VERSION,
						},
					}),
			),
		);

		const response = await call("login/options", {
			method: "POST",
			session: false,
			body: "{}",
		});

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			code: "ADMIN_INVALID_RESPONSE",
			message: "管理员服务返回无效",
		});
	});
});

describe("admin BFF session, CSRF, and safe errors", () => {
	it("rejects a session route before fetch when the session cookie is absent", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		const response = await call("configuration", { session: false });

		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(response.json()).resolves.toEqual({
			code: "ADMIN_SESSION_INVALID",
			message: "管理员会话已失效，请重新登录",
		});
	});

	it.each(["missing-ui-header", "cross-site", "foreign-origin"] as const)(
		"rejects a %s mutation as CSRF",
		async (csrf) => {
			const fetchMock = vi.fn<typeof fetch>();
			vi.stubGlobal("fetch", fetchMock);

			const response = await call("configuration/features.ai-assistance", {
				method: "PUT",
				csrf,
				body: JSON.stringify(UPDATE_BODY),
			});

			expect(response.status).toBe(403);
			expect(fetchMock).not.toHaveBeenCalled();
			await expect(response.json()).resolves.toEqual({
				code: "ADMIN_CSRF_REJECTED",
				message: "管理员请求来源校验失败",
			});
		},
	);

	it.each([
		[401, "ADMIN_SESSION_INVALID", "管理员会话已失效，请重新登录"],
		[403, "ADMIN_FORBIDDEN", "当前管理员没有此操作权限"],
		[404, "ADMIN_RESOURCE_NOT_FOUND", "管理员资源不存在"],
		[409, "ADMIN_CONFLICT", "当前状态已变化，请刷新后重试"],
	])(
		"maps upstream %i to a fixed safe problem",
		async (status, code, message) => {
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async () =>
					upstreamJson(
						{
							message: "database password: upstream-secret",
							stack: "sensitive upstream trace",
						},
						status,
					),
				),
			);

			const response = await call("configuration");
			const text = await response.text();

			expect(response.status).toBe(status);
			expect(text).not.toContain("upstream-secret");
			expect(text).not.toContain("sensitive upstream trace");
			expect(JSON.parse(text)).toEqual({ code, message });
		},
	);

	it.each([
		["PUT", "configuration/features.ai-assistance", UPDATE_BODY],
		[
			"POST",
			"configuration/features.ai-assistance/rollback",
			{
				expectedActiveVersion: 3,
				targetVersion: 1,
				changeReason: "ROLLBACK",
			},
		],
	])(
		"uses the configuration concurrency message for controlled %s /%s conflicts",
		async (method, path, body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async () =>
					upstreamJson({ message: "database password: upstream-secret" }, 409),
				),
			);

			const response = await call(path, {
				method,
				body: JSON.stringify(body),
			});
			const text = await response.text();

			expect(response.status).toBe(409);
			expect(text).not.toContain("upstream-secret");
			expect(JSON.parse(text)).toEqual({
				code: "ADMIN_CONFLICT",
				message: "配置已被其他管理员更新，请刷新最新版本后再提交",
			});
		},
	);

	it("keeps a last-credential deletion conflict generic and non-reflective", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () =>
				upstreamJson(
					{
						message:
							"cannot delete the last credential for upstream-secret-admin",
						stack: "sensitive upstream trace",
					},
					409,
				),
			),
		);

		const response = await call(`credentials/${"c".repeat(43)}`, {
			method: "DELETE",
		});
		const text = await response.text();

		expect(response.status).toBe(409);
		expect(text).not.toContain("upstream-secret-admin");
		expect(text).not.toContain("sensitive upstream trace");
		expect(JSON.parse(text)).toEqual({
			code: "ADMIN_CONFLICT",
			message: "当前状态已变化，请刷新后重试",
		});
	});
});
