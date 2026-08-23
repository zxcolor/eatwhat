import {
	ArgumentsHost,
	Catch,
	type ExceptionFilter,
	HttpException,
	HttpStatus,
	Logger,
} from "@nestjs/common";
import { bodyParserProblem } from "./http-problem-details.js";
import { requestIdFor } from "./safe-request-id.js";

interface MinimalRequest {
	readonly method: string;
	readonly path: string;
	readonly route?: { readonly path?: string };
	header(name: string): string | undefined;
}

interface MinimalResponse {
	setHeader?(name: string, value: string): void;
	status(code: number): MinimalResponse;
	json(payload: unknown): void;
}

interface SafeHttpErrorPayload {
	readonly code: string;
	readonly message: string;
	readonly issues?: readonly unknown[];
	readonly retryAfterSeconds?: number;
}

function safeIssues(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || value.length > 32) return undefined;
	const projected = value.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const issue = entry as Record<string, unknown>;
		if (
			typeof issue.message !== "string" ||
			issue.message.length === 0 ||
			issue.message.length > 200 ||
			!Array.isArray(issue.path) ||
			issue.path.length > 16 ||
			issue.path.some(
				(segment) =>
					!(
						typeof segment === "string" &&
						/^[A-Za-z0-9_-]{1,64}$/u.test(segment)
					) && !(typeof segment === "number" && Number.isSafeInteger(segment)),
			)
		) {
			return [];
		}
		return [{ path: issue.path, message: issue.message }];
	});
	return projected.length > 0 ? projected : undefined;
}

function safeHttpErrorPayload(
	status: number,
	payload: unknown,
): SafeHttpErrorPayload {
	if (typeof payload !== "object" || payload === null) {
		if (status === HttpStatus.NOT_FOUND) {
			return { code: "ROUTE_NOT_FOUND", message: "请求的接口不存在" };
		}
		return { code: "HTTP_ERROR", message: "请求未能完成" };
	}
	const candidate = payload as Record<string, unknown>;
	const projectedCode =
		typeof candidate.code === "string" &&
		/^[A-Z][A-Z0-9_]{1,63}$/u.test(candidate.code)
			? candidate.code
			: undefined;
	const controlledMessage =
		typeof candidate.message === "string" &&
		candidate.message.length > 0 &&
		candidate.message.length <= 200
			? candidate.message
			: undefined;
	if (
		status === HttpStatus.NOT_FOUND &&
		(projectedCode === undefined || controlledMessage === undefined)
	) {
		return { code: "ROUTE_NOT_FOUND", message: "请求的接口不存在" };
	}
	const code =
		projectedCode !== undefined
			? projectedCode
			: status === HttpStatus.BAD_REQUEST
				? "VALIDATION_ERROR"
				: "HTTP_ERROR";
	const message =
		controlledMessage !== undefined
			? controlledMessage
			: status === HttpStatus.BAD_REQUEST
				? "请求参数不符合要求"
				: "请求未能完成";
	const projected: {
		code: string;
		message: string;
		issues?: readonly unknown[];
		retryAfterSeconds?: number;
	} = { code, message };
	const issues = safeIssues(candidate.issues);
	if (issues !== undefined) projected.issues = issues;
	if (
		typeof candidate.retryAfterSeconds === "number" &&
		Number.isSafeInteger(candidate.retryAfterSeconds) &&
		candidate.retryAfterSeconds >= 0 &&
		candidate.retryAfterSeconds <= 86_400
	) {
		projected.retryAfterSeconds = candidate.retryAfterSeconds;
	}
	return projected;
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
	private readonly logger = new Logger(SafeExceptionFilter.name);

	catch(exception: unknown, host: ArgumentsHost): void {
		const context = host.switchToHttp();
		const request = context.getRequest<MinimalRequest>();
		const response = context.getResponse<MinimalResponse>();
		const parserProblem = bodyParserProblem(exception);
		const isHttpException = exception instanceof HttpException;
		const status =
			parserProblem?.status ??
			(isHttpException
				? exception.getStatus()
				: HttpStatus.INTERNAL_SERVER_ERROR);
		const requestId = requestIdFor(request);
		response.setHeader?.("X-Request-Id", requestId);

		// 只记录路由元数据，绝不记录请求体、查询参数、Authorization 或坐标。
		if (status >= 500) {
			this.logger.error(
				JSON.stringify({
					event: "request_failed",
					method: request.method,
					path: request.route?.path ?? "[unmatched]",
					status,
					requestId,
					errorType:
						exception instanceof Error ? exception.name : "UnknownError",
				}),
			);
		}

		if (parserProblem !== null) {
			response.status(status).json({
				requestId,
				code: parserProblem.code,
				message: parserProblem.message,
			});
			return;
		}

		if (isHttpException) {
			const payload = exception.getResponse();
			response.status(status).json({
				requestId,
				...safeHttpErrorPayload(status, payload),
			});
			return;
		}

		response.status(status).json({
			requestId,
			code: "INTERNAL_ERROR",
			message: "服务暂时不可用，请稍后重试",
		});
	}
}
