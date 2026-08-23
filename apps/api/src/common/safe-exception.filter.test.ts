import {
	type ArgumentsHost,
	HttpException,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeExceptionFilter } from "./safe-exception.filter.js";

function fixture(
	exception: unknown,
	path = "/private-value",
	suppliedRequestId?: string,
) {
	const json = vi.fn();
	const response = {
		setHeader: vi.fn(),
		status: vi.fn().mockReturnThis(),
		json,
	};
	const request = {
		method: "GET",
		path,
		header: vi.fn().mockReturnValue(suppliedRequestId),
	};
	const host = {
		switchToHttp: () => ({
			getRequest: () => request,
			getResponse: () => response,
		}),
	} as unknown as ArgumentsHost;
	new SafeExceptionFilter().catch(exception, host);
	return { response, body: json.mock.calls[0]?.[0] as Record<string, unknown> };
}

describe("SafeExceptionFilter public boundary", () => {
	afterEach(() => vi.restoreAllMocks());

	it("does not reflect an unmatched request path in a 404 response", () => {
		const { response, body } = fixture(
			new NotFoundException("Cannot GET /private-value"),
		);

		expect(response.status).toHaveBeenCalledWith(404);
		expect(body).toMatchObject({
			code: "ROUTE_NOT_FOUND",
			message: "请求的接口不存在",
		});
		expect(JSON.stringify(body)).not.toContain("private-value");
	});

	it("preserves an explicit business 404 contract", () => {
		const { response, body } = fixture(
			new NotFoundException({
				code: "EXPORT_NOT_FOUND",
				message: "导出任务不存在",
			}),
		);

		expect(response.status).toHaveBeenCalledWith(404);
		expect(body).toMatchObject({
			code: "EXPORT_NOT_FOUND",
			message: "导出任务不存在",
		});
	});

	it("projects only allow-listed fields from controlled HTTP errors", () => {
		vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
		const { response, body } = fixture(
			new ServiceUnavailableException({
				code: "SERVICE_NOT_READY",
				message: "服务尚未就绪，请稍后重试",
				retryAfterSeconds: 5,
				privateReason: "database password and upstream URL",
			}),
		);

		expect(body).toMatchObject({
			code: "SERVICE_NOT_READY",
			message: "服务尚未就绪，请稍后重试",
			retryAfterSeconds: 5,
		});
		expect(body).not.toHaveProperty("privateReason");
		expect(response.setHeader).toHaveBeenCalledWith(
			"X-Request-Id",
			body.requestId,
		);
		expect(Logger.prototype.error).toHaveBeenCalledWith(
			expect.not.stringContaining("private-value"),
		);
	});

	it("preserves one valid client request id in both header and body", () => {
		vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
		const supplied = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
		const { response, body } = fixture(
			new ServiceUnavailableException({
				code: "SERVICE_NOT_READY",
				message: "服务尚未就绪，请稍后重试",
			}),
			"/health/ready",
			supplied,
		);

		expect(body.requestId).toBe(supplied);
		expect(response.setHeader).toHaveBeenCalledWith("X-Request-Id", supplied);
	});

	it("does not expose arbitrary strings from unknown HTTP payloads", () => {
		const { body } = fixture(
			new HttpException("internal upstream URL and token", 418),
		);

		expect(body).toMatchObject({ code: "HTTP_ERROR", message: "请求未能完成" });
		expect(JSON.stringify(body)).not.toContain("upstream");
	});
});
