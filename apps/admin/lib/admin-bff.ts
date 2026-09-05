import "server-only";

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
	ADMIN_CONTRACT_HEADER,
	ADMIN_CLIENT_RELEASE_UNVERIFIED_MESSAGE,
	ADMIN_CONTRACT_VERSION,
	ADMIN_DEVICE_HEADER,
	type AdminConfigKey,
	isAdminConfigKey,
	isOpaqueToken,
	safeAdminAuditPage,
	safeAdminConfigRecord,
	safeAdminConfigRollbackRequest,
	safeAdminConfigUpdateRequest,
	safeAdminConfigurationHistory,
	safeAdminConfigurationPage,
	safeAdminCredentialCreated,
	safeAdminCredentialList,
	safeAdminSession,
} from "./admin-contract";

const MAX_REQUEST_BYTES = 100 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface RoutePolicy {
	upstreamPath: string;
	requiresSession: boolean;
	configKey?: AdminConfigKey;
	loginVerification?: boolean;
	sessionResponse?: boolean;
	logout?: boolean;
	requestKind?: "CONFIGURATION_UPDATE" | "CONFIGURATION_ROLLBACK";
	responseKind?:
		| "CREDENTIAL_LIST"
		| "CREDENTIAL_CREATED"
		| "AUDIT"
		| "CONFIGURATION_PAGE"
		| "CONFIGURATION_HISTORY"
		| "CONFIGURATION_RECORD";
}

function apiBaseUrl(): string {
	return (process.env.ADMIN_API_BASE_URL ?? "http://127.0.0.1:3002").replace(
		/\/$/,
		"",
	);
}

function insecureLoopbackAllowed(request: NextRequest): boolean {
	return (
		process.env.ADMIN_ALLOW_INSECURE_LOOPBACK === "true" &&
		(request.nextUrl.hostname === "127.0.0.1" ||
			request.nextUrl.hostname === "localhost")
	);
}

function cookiePolicy(request: NextRequest) {
	const secure =
		process.env.NODE_ENV === "production" && !insecureLoopbackAllowed(request);
	return {
		tokenName: secure ? "__Host-chishenme_admin" : "chishenme_admin_loopback",
		deviceName: secure
			? "__Host-chishenme_admin_device"
			: "chishenme_admin_device_loopback",
		secure,
	};
}

function trustedClientIp(request: NextRequest): string | null {
	if (
		process.env.NODE_ENV !== "production" ||
		insecureLoopbackAllowed(request)
	) {
		return "127.0.0.1";
	}
	if (process.env.ADMIN_SHARED_EDGE_RATE_LIMIT_ENABLED !== "true") return null;
	const configuredHeader =
		process.env.ADMIN_TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
	if (
		configuredHeader === undefined ||
		!/^x-[a-z0-9-]{2,60}$/.test(configuredHeader) ||
		configuredHeader === "x-forwarded-for"
	) {
		return null;
	}
	// Production ingress must strip any browser-provided value and overwrite
	// this dedicated header with exactly one canonical client address. The BFF
	// intentionally ignores the browser's X-Forwarded-For chain.
	const value = request.headers.get(configuredHeader)?.trim();
	return value !== undefined && value !== null && isIP(value) !== 0
		? value
		: null;
}

function routePolicy(
	method: string,
	segments: string[],
	request: NextRequest,
): RoutePolicy | null {
	const path = segments.join("/");
	const hasNoQuery = [...request.nextUrl.searchParams.keys()].length === 0;
	if (method === "POST" && path === "login/options" && hasNoQuery) {
		return {
			upstreamPath: "/admin/v1/auth/login/options",
			requiresSession: false,
		};
	}
	if (method === "POST" && path === "login/verify" && hasNoQuery) {
		return {
			upstreamPath: "/admin/v1/auth/login/verify",
			requiresSession: false,
			loginVerification: true,
		};
	}
	if (method === "GET" && path === "session" && hasNoQuery) {
		return {
			upstreamPath: "/admin/v1/session",
			requiresSession: true,
			sessionResponse: true,
		};
	}
	if (method === "POST" && path === "logout" && hasNoQuery) {
		return {
			upstreamPath: "/admin/v1/session/logout",
			requiresSession: true,
			logout: true,
		};
	}
	if (method === "GET" && path === "credentials" && hasNoQuery) {
		return {
			upstreamPath: "/admin/v1/credentials",
			requiresSession: true,
			responseKind: "CREDENTIAL_LIST",
		};
	}
	if (
		method === "POST" &&
		path === "credentials/enroll/options" &&
		hasNoQuery
	) {
		return {
			upstreamPath: "/admin/v1/credentials/enroll/options",
			requiresSession: true,
		};
	}
	if (method === "POST" && path === "credentials/enroll/verify" && hasNoQuery) {
		return {
			upstreamPath: "/admin/v1/credentials/enroll/verify",
			requiresSession: true,
			responseKind: "CREDENTIAL_CREATED",
		};
	}
	if (
		method === "DELETE" &&
		segments.length === 2 &&
		segments[0] === "credentials" &&
		hasNoQuery
	) {
		const handle = segments[1];
		if (handle !== undefined && OPAQUE_PATTERN.test(handle)) {
			return {
				upstreamPath: `/admin/v1/credentials/${encodeURIComponent(handle)}`,
				requiresSession: true,
			};
		}
	}
	if (method === "GET" && path === "audit") {
		const queryKeys = [...request.nextUrl.searchParams.keys()];
		if (
			queryKeys.some((key) => key !== "cursor" && key !== "limit") ||
			request.nextUrl.searchParams.getAll("cursor").length > 1 ||
			request.nextUrl.searchParams.getAll("limit").length > 1
		)
			return null;
		const cursor = request.nextUrl.searchParams.get("cursor");
		const limit = request.nextUrl.searchParams.get("limit") ?? "50";
		if (cursor !== null && !OPAQUE_PATTERN.test(cursor)) return null;
		if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit)) return null;
		const query = new URLSearchParams({ limit });
		if (cursor !== null) query.set("cursor", cursor);
		return {
			upstreamPath: `/admin/v1/audit?${query.toString()}`,
			requiresSession: true,
			responseKind: "AUDIT",
		};
	}
	if (method === "GET" && path === "configuration" && hasNoQuery) {
		return {
			upstreamPath: "/admin/v1/configuration",
			requiresSession: true,
			responseKind: "CONFIGURATION_PAGE",
		};
	}
	if (
		method === "GET" &&
		segments.length === 3 &&
		segments[0] === "configuration" &&
		isAdminConfigKey(segments[1]) &&
		segments[2] === "history"
	) {
		const queryKeys = [...request.nextUrl.searchParams.keys()];
		if (
			queryKeys.some((key) => key !== "limit") ||
			request.nextUrl.searchParams.getAll("limit").length > 1
		) {
			return null;
		}
		const limit = request.nextUrl.searchParams.get("limit") ?? "20";
		if (!/^(?:[1-9]|1[0-9]|20)$/.test(limit)) return null;
		const configKey = segments[1];
		return {
			upstreamPath: `/admin/v1/configuration/${encodeURIComponent(configKey)}/history?limit=${limit}`,
			requiresSession: true,
			configKey,
			responseKind: "CONFIGURATION_HISTORY",
		};
	}
	if (
		method === "PUT" &&
		segments.length === 2 &&
		segments[0] === "configuration" &&
		isAdminConfigKey(segments[1]) &&
		hasNoQuery
	) {
		const configKey = segments[1];
		return {
			upstreamPath: `/admin/v1/configuration/${encodeURIComponent(configKey)}`,
			requiresSession: true,
			configKey,
			requestKind: "CONFIGURATION_UPDATE",
			responseKind: "CONFIGURATION_RECORD",
		};
	}
	if (
		method === "POST" &&
		segments.length === 3 &&
		segments[0] === "configuration" &&
		isAdminConfigKey(segments[1]) &&
		segments[2] === "rollback" &&
		hasNoQuery
	) {
		const configKey = segments[1];
		return {
			upstreamPath: `/admin/v1/configuration/${encodeURIComponent(configKey)}/rollback`,
			requiresSession: true,
			configKey,
			requestKind: "CONFIGURATION_ROLLBACK",
			responseKind: "CONFIGURATION_RECORD",
		};
	}
	return null;
}

function isSameOriginMutation(request: NextRequest): boolean {
	if (request.headers.get("x-chishenme-admin-ui") !== "1") return false;
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite !== null && fetchSite !== "same-origin") return false;
	const origin = request.headers.get("origin");
	if (origin === null) return true;
	try {
		return new URL(origin).host === request.headers.get("host");
	} catch {
		return false;
	}
}

function cookieOptions(secure: boolean, maxAge?: number) {
	return {
		httpOnly: true,
		secure,
		sameSite: "strict" as const,
		path: "/",
		...(maxAge === undefined ? {} : { maxAge }),
	};
}

function problem(status: number, code: string, message: string): NextResponse {
	return NextResponse.json(
		{ code, message },
		{
			status,
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}

function upstreamProblem(
	status: number,
	requestKind?: RoutePolicy["requestKind"],
): NextResponse {
	if (status === 400)
		return problem(400, "INVALID_ADMIN_REQUEST", "管理员请求无效");
	if (status === 401)
		return problem(
			401,
			"ADMIN_SESSION_INVALID",
			"管理员会话已失效，请重新登录",
		);
	if (status === 403)
		return problem(403, "ADMIN_FORBIDDEN", "当前管理员没有此操作权限");
	if (status === 404)
		return problem(404, "ADMIN_RESOURCE_NOT_FOUND", "管理员资源不存在");
	if (status === 409) {
		const message =
			requestKind === "CONFIGURATION_UPDATE" ||
			requestKind === "CONFIGURATION_ROLLBACK"
				? "配置已被其他管理员更新，请刷新最新版本后再提交"
				: "当前状态已变化，请刷新后重试";
		return problem(409, "ADMIN_CONFLICT", message);
	}
	if (status === 429)
		return problem(429, "ADMIN_RATE_LIMITED", "请求过于频繁，请稍后重试");
	return problem(503, "ADMIN_UNAVAILABLE", "管理员服务暂不可用");
}

interface ParsedRequestBody {
	raw: string;
	value: Record<string, unknown>;
}

async function readBody(
	request: NextRequest,
): Promise<ParsedRequestBody | null> {
	const contentType = request.headers.get("content-type");
	if (
		contentType === null ||
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
	) {
		return null;
	}
	const declaredLength = request.headers.get("content-length");
	if (
		declaredLength !== null &&
		(!/^\d+$/.test(declaredLength) ||
			Number(declaredLength) > MAX_REQUEST_BYTES)
	)
		return null;
	if (request.body === null) return null;
	const reader = request.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let received = 0;
	let body = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += chunk.value.byteLength;
			if (received > MAX_REQUEST_BYTES) {
				await reader.cancel();
				return null;
			}
			body += decoder.decode(chunk.value, { stream: true });
		}
		body += decoder.decode();
	} catch {
		await reader.cancel().catch(() => undefined);
		return null;
	} finally {
		reader.releaseLock();
	}
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return null;
		return { raw: body, value: parsed as Record<string, unknown> };
	} catch {
		return null;
	}
}

async function readUpstreamText(response: Response): Promise<string | null> {
	const declaredLength = response.headers.get("content-length");
	if (
		declaredLength !== null &&
		(!/^\d+$/.test(declaredLength) ||
			Number(declaredLength) > MAX_RESPONSE_BYTES)
	) {
		await response.body?.cancel();
		return null;
	}
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let received = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += chunk.value.byteLength;
			if (received > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} catch {
		await reader.cancel().catch(() => undefined);
		return null;
	} finally {
		reader.releaseLock();
	}
}

function setDeviceCookie(
	response: NextResponse,
	cookie: ReturnType<typeof cookiePolicy>,
	deviceId: string,
): void {
	response.cookies.set(
		cookie.deviceName,
		deviceId,
		cookieOptions(cookie.secure, 365 * 24 * 60 * 60),
	);
}

function clearTokenCookie(
	response: NextResponse,
	cookie: ReturnType<typeof cookiePolicy>,
): void {
	response.cookies.set(cookie.tokenName, "", cookieOptions(cookie.secure, 0));
}

export async function proxyAdminRequest(
	request: NextRequest,
	segments: string[],
): Promise<NextResponse> {
	const method = request.method.toUpperCase();
	const policy = routePolicy(method, segments, request);
	if (policy === null)
		return problem(404, "ADMIN_ROUTE_NOT_FOUND", "管理员接口不存在");
	const clientIp = trustedClientIp(request);
	if (clientIp === null) {
		return problem(
			503,
			"ADMIN_INGRESS_NOT_READY",
			"管理员入口的可信代理或共享限流尚未配置",
		);
	}
	if (method !== "GET" && !isSameOriginMutation(request)) {
		return problem(403, "ADMIN_CSRF_REJECTED", "管理员请求来源校验失败");
	}

	const cookie = cookiePolicy(request);
	const existingDeviceId = request.cookies.get(cookie.deviceName)?.value;
	const deviceId = isOpaqueToken(existingDeviceId)
		? existingDeviceId
		: randomBytes(32).toString("base64url");
	const token = request.cookies.get(cookie.tokenName)?.value;
	if (policy.requiresSession && !isOpaqueToken(token)) {
		const response = upstreamProblem(401);
		clearTokenCookie(response, cookie);
		setDeviceCookie(response, cookie, deviceId);
		return response;
	}

	let body: string | undefined;
	if (method !== "GET" && method !== "DELETE") {
		const parsed = await readBody(request);
		if (parsed === null)
			return problem(400, "INVALID_ADMIN_REQUEST", "管理员请求无效");
		if (policy.requestKind === "CONFIGURATION_UPDATE") {
			if (policy.configKey === undefined)
				return problem(404, "ADMIN_ROUTE_NOT_FOUND", "管理员接口不存在");
			const projected = safeAdminConfigUpdateRequest(
				parsed.value,
				policy.configKey,
			);
			if (projected === null)
				return problem(400, "INVALID_ADMIN_REQUEST", "配置字段或更改原因无效");
			body = JSON.stringify(projected);
		} else if (policy.requestKind === "CONFIGURATION_ROLLBACK") {
			const projected = safeAdminConfigRollbackRequest(parsed.value);
			if (projected === null)
				return problem(400, "INVALID_ADMIN_REQUEST", "回滚目标或版本信息无效");
			body = JSON.stringify(projected);
		} else {
			body = parsed.raw;
		}
	}

	const headers = new Headers({
		Accept: "application/json",
		[ADMIN_CONTRACT_HEADER]: ADMIN_CONTRACT_VERSION,
		[ADMIN_DEVICE_HEADER]: deviceId,
		// This value is generated from the trusted ingress-only header above.
		// Incoming browser X-Forwarded-For is never copied.
		"X-Forwarded-For": clientIp,
	});
	if (body !== undefined)
		headers.set("Content-Type", "application/json; charset=utf-8");
	if (policy.requiresSession && token !== undefined)
		headers.set("Authorization", `Bearer ${token}`);

	let upstream: Response;
	try {
		upstream = await fetch(`${apiBaseUrl()}${policy.upstreamPath}`, {
			method,
			headers,
			...(body === undefined ? {} : { body }),
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.timeout(6_000),
		});
	} catch {
		const response = problem(503, "ADMIN_UNAVAILABLE", "管理员服务暂不可用");
		if (policy.logout) clearTokenCookie(response, cookie);
		setDeviceCookie(response, cookie, deviceId);
		return response;
	}

	if (upstream.headers.get(ADMIN_CONTRACT_HEADER) !== ADMIN_CONTRACT_VERSION) {
		await upstream.body?.cancel().catch(() => undefined);
		const response = problem(
			503,
			"ADMIN_CONTRACT_MISMATCH",
			"管理后台与服务端版本不兼容",
		);
		if (policy.logout) clearTokenCookie(response, cookie);
		setDeviceCookie(response, cookie, deviceId);
		return response;
	}
	if (!upstream.ok) {
		let response: NextResponse | null = null;
		if (
			upstream.status === 409 && policy.configKey === "clients.minimum-version" &&
			(policy.requestKind === "CONFIGURATION_UPDATE" || policy.requestKind === "CONFIGURATION_ROLLBACK")
		) {
			// Inspect only the bounded error code; never forward upstream messages,
			// traces or metadata. A release gate is not a concurrent-edit conflict.
			const errorText = await readUpstreamText(upstream);
			try {
				const error: unknown = errorText === null ? null : JSON.parse(errorText);
				if (typeof error === "object" && error !== null && !Array.isArray(error) &&
					"code" in error && error.code === "CLIENT_RELEASE_UNVERIFIED") {
					response = problem(409, "CLIENT_RELEASE_UNVERIFIED", ADMIN_CLIENT_RELEASE_UNVERIFIED_MESSAGE);
				}
			} catch {
				// Malformed upstream errors receive the existing fixed safe response.
			}
		} else {
			await upstream.body?.cancel().catch(() => undefined);
		}
		response ??= upstreamProblem(upstream.status, policy.requestKind);
		if (upstream.status === 401 || policy.logout)
			clearTokenCookie(response, cookie);
		setDeviceCookie(response, cookie, deviceId);
		return response;
	}

	if (policy.logout || upstream.status === 204) {
		const response = new NextResponse(null, {
			status: 204,
			headers: { "Cache-Control": "no-store" },
		});
		if (policy.logout) clearTokenCookie(response, cookie);
		setDeviceCookie(response, cookie, deviceId);
		return response;
	}

	const responseText = await readUpstreamText(upstream);
	if (responseText === null) {
		return problem(503, "ADMIN_INVALID_RESPONSE", "管理员服务返回无效");
	}
	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		return problem(503, "ADMIN_INVALID_RESPONSE", "管理员服务返回无效");
	}

	if (policy.loginVerification) {
		if (typeof payload !== "object" || payload === null) {
			return problem(503, "ADMIN_INVALID_RESPONSE", "管理员服务返回无效");
		}
		const source = payload as Record<string, unknown>;
		if (!isOpaqueToken(source.adminToken)) {
			return problem(503, "ADMIN_INVALID_RESPONSE", "管理员服务返回无效");
		}
		const safeSession = {
			absoluteExpiresAt: source.absoluteExpiresAt,
			idleTimeoutSeconds: source.idleTimeoutSeconds,
			permissions: source.permissions,
		};
		const projectedSession = safeAdminSession(safeSession);
		if (projectedSession === null) {
			return problem(503, "ADMIN_INVALID_RESPONSE", "管理员服务返回无效");
		}
		const response = NextResponse.json(projectedSession, {
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
		const expiresMs = Date.parse(projectedSession.absoluteExpiresAt);
		const maxAge = Math.max(
			1,
			Math.min(8 * 60 * 60, Math.floor((expiresMs - Date.now()) / 1_000)),
		);
		response.cookies.set(
			cookie.tokenName,
			source.adminToken,
			cookieOptions(cookie.secure, maxAge),
		);
		setDeviceCookie(response, cookie, deviceId);
		return response;
	}

	if (policy.sessionResponse) payload = safeAdminSession(payload);
	if (policy.responseKind === "CREDENTIAL_LIST")
		payload = safeAdminCredentialList(payload);
	if (policy.responseKind === "CREDENTIAL_CREATED")
		payload = safeAdminCredentialCreated(payload);
	if (policy.responseKind === "AUDIT") payload = safeAdminAuditPage(payload);
	if (policy.responseKind === "CONFIGURATION_PAGE")
		payload = safeAdminConfigurationPage(payload);
	if (policy.responseKind === "CONFIGURATION_HISTORY") {
		payload =
			policy.configKey === undefined
				? null
				: safeAdminConfigurationHistory(payload, policy.configKey);
	}
	if (policy.responseKind === "CONFIGURATION_RECORD") {
		const record = safeAdminConfigRecord(payload);
		payload =
			record !== null && record.configKey === policy.configKey ? record : null;
	}
	if (payload === null)
		return problem(503, "ADMIN_INVALID_RESPONSE", "管理员服务返回无效");

	const response = NextResponse.json(payload, {
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
	setDeviceCookie(response, cookie, deviceId);
	return response;
}
