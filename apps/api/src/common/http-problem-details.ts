import { HttpStatus } from "@nestjs/common";

export interface SafeProblem {
	readonly status: number;
	readonly code: string;
	readonly message: string;
}

/** Maps only known body-parser failures and never reflects parser error text. */
export function bodyParserProblem(exception: unknown): SafeProblem | null {
	if (typeof exception !== "object" || exception === null) return null;
	const failure = exception as {
		readonly type?: unknown;
		readonly status?: unknown;
		readonly statusCode?: unknown;
	};
	const status = failure.status ?? failure.statusCode;

	if (
		failure.type === "entity.parse.failed" &&
		status === HttpStatus.BAD_REQUEST
	) {
		return {
			status: HttpStatus.BAD_REQUEST,
			code: "INVALID_JSON",
			message: "请求体不是有效的 JSON",
		};
	}
	if (
		failure.type === "entity.too.large" &&
		status === HttpStatus.PAYLOAD_TOO_LARGE
	) {
		return {
			status: HttpStatus.PAYLOAD_TOO_LARGE,
			code: "PAYLOAD_TOO_LARGE",
			message: "请求体不能超过 100 KiB",
		};
	}
	if (
		(failure.type === "charset.unsupported" ||
			failure.type === "encoding.unsupported") &&
		status === HttpStatus.UNSUPPORTED_MEDIA_TYPE
	) {
		return {
			status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
			code: "UNSUPPORTED_MEDIA_TYPE",
			message: "请求体编码不受支持",
		};
	}
	return null;
}
