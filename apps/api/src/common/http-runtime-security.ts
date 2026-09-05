import {
	ADMIN_CONTRACT_VERSION_HEADER,
	CONTRACT_VERSION_HEADER,
	CURRENT_ADMIN_CONTRACT_VERSION,
	CURRENT_CONTRACT_VERSION,
} from "@chi-shen-me/contracts";
import { bodyParserProblem } from "./http-problem-details.js";
import { requestIdFor } from "./safe-request-id.js";

const JSON_BODY_LIMIT_BYTES = 100 * 1_024;

interface ExpressRequest {
	readonly method?: string;
	readonly path?: string;
	readonly originalUrl?: string;
	header?(name: string): string | undefined;
}

interface ExpressResponse {
	setHeader(name: string, value: string): void;
	status(code: number): ExpressResponse;
	json(payload: unknown): void;
}

type ExpressNext = (error?: unknown) => void;
type ExpressMiddleware = (
	request: ExpressRequest,
	response: ExpressResponse,
	next: ExpressNext,
) => void;
type ExpressErrorMiddleware = (
	error: unknown,
	request: ExpressRequest,
	response: ExpressResponse,
	next: ExpressNext,
) => void;

interface ExpressRuntime {
	disable?: (name: string) => void;
	set?: (name: string, value: unknown) => void;
	use?: (middleware: ExpressMiddleware | ExpressErrorMiddleware) => void;
}

interface HttpRuntimeApplication {
	getHttpAdapter(): { getInstance(): ExpressRuntime };
	useBodyParser(type: "json", options: { readonly limit: number }): unknown;
}

interface HttpRuntimeSecurityConfig {
	readonly trustedProxyCidrs: readonly string[];
	readonly auth: { readonly enabled: boolean };
	readonly admin: { readonly enabled: boolean };
}

const JSON_POST_PATHS = new Set([
	"/v1/account/export",
	"/v1/auth/email/request-code",
	"/v1/auth/identities",
	"/v1/auth/login",
	"/v1/auth/logout",
	"/v1/auth/oauth/state",
	"/v1/auth/phone/request-code",
	"/v1/auth/refresh",
	"/v1/auth/register/phone-wechat",
	"/v1/favorites",
	"/v1/group-recommendations",
	"/v1/location-search",
	"/v1/place-search",
	"/v1/private-feedback",
	"/v1/recommendations",
	"/v1/recommendation-events",
	"/v1/support-feedback",
	"/admin/v1/auth/login/options",
	"/admin/v1/auth/login/verify",
	"/admin/v1/credentials/enroll/options",
	"/admin/v1/credentials/enroll/verify",
	"/admin/v1/session/logout",
]);

const JSON_DELETE_PATHS = new Set(["/v1/account"]);

function requestPath(request: ExpressRequest): string {
	const rawPath = request.path ?? request.originalUrl?.split("?", 1)[0] ?? "";
	return rawPath.length > 1 && rawPath.endsWith("/")
		? rawPath.slice(0, -1)
		: rawPath;
}

function acceptsJson(request: ExpressRequest): boolean {
	const mediaType = request
		.header?.("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	return mediaType === "application/json";
}

function isAccountEndpoint(path: string): boolean {
	return (
		path === "/v1/account" ||
		path.startsWith("/v1/account/") ||
		path === "/v1/auth" ||
		path.startsWith("/v1/auth/") ||
		path === "/v1/favorites" ||
		path.startsWith("/v1/favorites/") ||
		path === "/v1/history" ||
		path === "/v1/private-feedback" ||
		path.startsWith("/v1/private-feedback/")
	);
}

function isJsonPostPath(path: string): boolean {
	return (
		JSON_POST_PATHS.has(path) ||
		/^\/v1\/favorites\/[0-9a-f-]{36}\/group$/iu.test(path)
	);
}

export const applySecurityHeaders: ExpressMiddleware = (
	request,
	response,
	next,
) => {
	// Set the server-owned compatibility value before content-type checks and the
	// body parser so success and every error path carry the same handshake.
	response.setHeader(CONTRACT_VERSION_HEADER, CURRENT_CONTRACT_VERSION);
	response.setHeader("X-Request-Id", requestIdFor(request));
	if (requestPath(request).startsWith("/admin/v1/")) {
		response.setHeader(
			ADMIN_CONTRACT_VERSION_HEADER,
			CURRENT_ADMIN_CONTRACT_VERSION,
		);
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		response.setHeader(
			"Permissions-Policy",
			"camera=(), microphone=(), geolocation=(), payment=()",
		);
	}
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Referrer-Policy", "no-referrer");
	// Config and recommendation responses can be user/session-specific and must not be cached.
	response.setHeader("Cache-Control", "no-store");
	next();
};

/**
 * Account routes fail closed before content-type parsing, guards and pipes. This
 * makes a disabled deployment return one stable 503 even for malformed or
 * body-less requests, without reading or reflecting authentication material.
 */
export function rejectDisabledAccountEndpoints(
	accountsEnabled: boolean,
): ExpressMiddleware {
	return (request, response, next) => {
		if (accountsEnabled || !isAccountEndpoint(requestPath(request))) {
			next();
			return;
		}
		response.status(503).json({
			requestId: requestIdFor(request),
			code: "AUTH_CHANNEL_UNAVAILABLE",
			message: "该账号能力暂未开放或暂时不可用",
		});
	};
}

function isAdminEndpoint(path: string): boolean {
	return path === "/admin/v1" || path.startsWith("/admin/v1/");
}

export function rejectDisabledAdminEndpoints(
	adminEnabled: boolean,
): ExpressMiddleware {
	return (request, response, next) => {
		if (adminEnabled || !isAdminEndpoint(requestPath(request))) {
			next();
			return;
		}
		response.status(503).json({
			requestId: requestIdFor(request),
			code: "ADMIN_API_UNAVAILABLE",
			message: "管理员服务暂时不可用",
		});
	};
}

export const requireJsonContentType: ExpressMiddleware = (
	request,
	response,
	next,
) => {
	const method = request.method?.toUpperCase();
	const path = requestPath(request);
	if (
		!(
			(method === "POST" && isJsonPostPath(path)) ||
			(method === "DELETE" && JSON_DELETE_PATHS.has(path))
		) ||
		acceptsJson(request)
	) {
		next();
		return;
	}

	response.status(415).json({
		requestId: requestIdFor(request),
		code: "UNSUPPORTED_MEDIA_TYPE",
		message: "Content-Type 必须为 application/json",
	});
};

export const handleBodyParserError: ExpressErrorMiddleware = (
	exception: unknown,
	request: ExpressRequest,
	response: ExpressResponse,
	next: ExpressNext,
): void => {
	const problem = bodyParserProblem(exception);
	if (problem === null) {
		next(exception);
		return;
	}
	response.status(problem.status).json({
		requestId: requestIdFor(request),
		code: problem.code,
		message: problem.message,
	});
};

export function configureHttpRuntime(
	app: HttpRuntimeApplication,
	config: HttpRuntimeSecurityConfig,
): void {
	const instance = app.getHttpAdapter().getInstance();
	instance.disable?.("x-powered-by");
	// Express ignores X-Forwarded-For when trust proxy is false. Only validated,
	// explicitly bounded proxy networks may opt in to forwarded client IPs.
	instance.set?.(
		"trust proxy",
		config.trustedProxyCidrs.length === 0
			? false
			: [...config.trustedProxyCidrs],
	);
	instance.use?.(applySecurityHeaders);
	instance.use?.(rejectDisabledAccountEndpoints(config.auth.enabled));
	instance.use?.(rejectDisabledAdminEndpoints(config.admin.enabled));
	instance.use?.(requireJsonContentType);
	app.useBodyParser("json", { limit: JSON_BODY_LIMIT_BYTES });
	// This must be registered immediately after the parser so parser failures cannot
	// fall through to Express/Nest default messages that expose implementation details.
	instance.use?.(handleBodyParserError);
}
