import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";

export class AuthInvalidRequestException extends BadRequestException {
	constructor() {
		super({ code: "INVALID_REQUEST", message: "请求参数不符合接口约定" });
	}
}

export type AuthUnauthorizedCode =
	| "AUTHENTICATION_REQUIRED"
	| "INVALID_CREDENTIALS"
	| "IDENTITY_NOT_BOUND"
	| "SESSION_EXPIRED"
	| "TOKEN_REPLAY_DETECTED";

export class AuthUnavailableException extends ServiceUnavailableException {
	constructor() {
		super({
			code: "AUTH_CHANNEL_UNAVAILABLE",
			message: "该账号能力暂未开放或暂时不可用",
		});
	}
}

export class AuthUnauthorizedException extends HttpException {
	constructor(code: AuthUnauthorizedCode = "AUTHENTICATION_REQUIRED") {
		super(
			{ code, message: "身份验证失败或会话已失效" },
			HttpStatus.UNAUTHORIZED,
		);
	}
}

export type AuthConflictCode =
	| "IDENTITY_ALREADY_BOUND"
	| "IDENTITY_BINDING_CONFLICT"
	| "CHALLENGE_ALREADY_CONSUMED"
	| "SESSION_CONFLICT"
	| "ACCOUNT_DELETION_PENDING";

export class AuthConflictException extends HttpException {
	constructor(code: AuthConflictCode = "IDENTITY_BINDING_CONFLICT") {
		super(
			{ code, message: "身份、验证流程或会话状态冲突" },
			HttpStatus.CONFLICT,
		);
	}
}

export type AuthForbiddenCode =
	| "ACTION_NOT_ALLOWED"
	| "REAUTH_REQUIRED"
	| "RISK_CHECK_FAILED";

export class AuthForbiddenException extends ForbiddenException {
	constructor(code: AuthForbiddenCode = "ACTION_NOT_ALLOWED") {
		super({ code, message: "当前账号或设备不允许执行此操作" });
	}
}

export class AccountExportNotFoundException extends NotFoundException {
	constructor() {
		super({ code: "EXPORT_NOT_FOUND", message: "数据导出记录不存在" });
	}
}

export class AccountExportNotReadyException extends HttpException {
	constructor() {
		super(
			{ code: "EXPORT_NOT_READY", message: "数据导出尚未可下载" },
			HttpStatus.CONFLICT,
		);
	}
}

export class AccountExportExpiredException extends HttpException {
	constructor() {
		super(
			{ code: "EXPORT_EXPIRED", message: "数据导出文件已过期" },
			HttpStatus.GONE,
		);
	}
}

export class AuthRateLimitedException extends HttpException {
	readonly retryAfterSeconds: number;

	constructor(retryAfterSeconds: number) {
		const normalizedRetryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
		super(
			{
				code: "RATE_LIMITED",
				message: "请求过于频繁，请稍后重试",
				retryAfterSeconds: normalizedRetryAfter,
			},
			HttpStatus.TOO_MANY_REQUESTS,
		);
		this.retryAfterSeconds = normalizedRetryAfter;
	}
}
