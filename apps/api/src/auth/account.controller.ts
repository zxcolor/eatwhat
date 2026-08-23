import {
	type AccountExportIdPath,
	AccountExportIdPathSchema,
	type AccountExportRequest,
	AccountExportRequestSchema,
	type DeleteAccountRequest,
	DeleteAccountRequestSchema,
} from "@chi-shen-me/contracts";
import {
	Body,
	Controller,
	Delete,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	Post,
	RequestTimeoutException,
	Res,
	StreamableFile,
	UseGuards,
} from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { AuthService } from "./auth.service.js";
import { AuthAvailabilityGuard } from "./auth-availability.guard.js";
import { requireBearerAccessToken } from "./bearer-token.js";

interface ExportDownloadResponse {
	setHeader(name: string, value: string): void;
	setTimeout(milliseconds: number, callback?: () => void): void;
	once(
		event: "finish" | "close" | "error" | "timeout",
		listener: () => void,
	): void;
	removeListener(
		event: "finish" | "close" | "error" | "timeout",
		listener: () => void,
	): void;
	destroy(): void;
	readonly destroyed?: boolean;
	readonly closed?: boolean;
	readonly writableEnded?: boolean;
	readonly writableFinished?: boolean;
}

const EXPORT_FILENAME = "chi-shen-me-account-export.json";

@Controller("v1/account")
@UseGuards(AuthAvailabilityGuard)
export class AccountController {
	constructor(
		private readonly service: AuthService,
		@Inject(APP_CONFIG) private readonly config: AppConfig,
	) {}

	@Post("export")
	@HttpCode(HttpStatus.ACCEPTED)
	@RateLimit(5, 60_000)
	requestExport(
		@Body(new ZodBodyPipe(AccountExportRequestSchema))
		input: AccountExportRequest,
		@Headers("authorization") authorization: string | undefined,
	) {
		return this.service.requestExport(
			requireBearerAccessToken(authorization),
			input,
		);
	}

	@Get("exports/latest")
	@RateLimit(30, 60_000)
	getLatestExport(@Headers("authorization") authorization: string | undefined) {
		return this.service.getLatestExport(
			requireBearerAccessToken(authorization),
		);
	}

	@Get("exports/:exportId/content")
	@RateLimit(5, 60_000)
	async downloadExport(
		@Param(new ZodBodyPipe(AccountExportIdPathSchema))
		path: AccountExportIdPath,
		@Headers("authorization") authorization: string | undefined,
		@Res({ passthrough: true }) response: ExportDownloadResponse,
	) {
		const deadline = armExportDownloadDeadline(
			response,
			this.config.dataExportDownload.totalTimeoutMs,
			this.config.dataExportDownload.idleTimeoutMs,
		);
		let bodyToDestroy:
			| Awaited<ReturnType<AuthService["openExportContent"]>>["body"]
			| null = null;
		try {
			const content = await this.service.openExportContent(
				requireBearerAccessToken(authorization),
				path.exportId,
			);
			bodyToDestroy = content.body;
			deadline.trackBody(content.body);
			if (deadline.responseUnavailable()) {
				throw new RequestTimeoutException("账号数据导出下载已超时");
			}
			const digest = Buffer.from(content.sha256, "hex").toString("base64");
			response.setHeader(
				"Content-Type",
				`${content.contentType}; charset=utf-8`,
			);
			response.setHeader("Content-Length", String(content.sizeBytes));
			response.setHeader("Digest", `sha-256=${digest}`);
			response.setHeader("X-Content-SHA256", content.sha256);
			response.setHeader(
				"Content-Disposition",
				`attachment; filename="${EXPORT_FILENAME}"`,
			);
			response.setHeader("Cache-Control", "private, no-store");
			response.setHeader("Pragma", "no-cache");
			response.setHeader("Accept-Ranges", "none");
			const file = new StreamableFile(content.body);
			bodyToDestroy = null;
			return file;
		} catch (error) {
			bodyToDestroy?.destroy();
			deadline.clear();
			throw error;
		}
	}

	@Get("exports/:exportId")
	@RateLimit(30, 60_000)
	getExport(
		@Param(new ZodBodyPipe(AccountExportIdPathSchema))
		path: AccountExportIdPath,
		@Headers("authorization") authorization: string | undefined,
	) {
		return this.service.getExport(
			requireBearerAccessToken(authorization),
			path.exportId,
		);
	}

	@Delete()
	@HttpCode(HttpStatus.ACCEPTED)
	@RateLimit(3, 60_000)
	deleteAccount(
		@Body(new ZodBodyPipe(DeleteAccountRequestSchema))
		input: DeleteAccountRequest,
		@Headers("authorization") authorization: string | undefined,
	) {
		return this.service.deleteAccount(
			requireBearerAccessToken(authorization),
			input,
		);
	}
}

interface ExportDownloadDeadline {
	readonly responseUnavailable: () => boolean;
	readonly trackBody: (
		body: Awaited<ReturnType<AuthService["openExportContent"]>>["body"],
	) => void;
	readonly clear: () => void;
}

function armExportDownloadDeadline(
	response: ExportDownloadResponse,
	totalTimeoutMs: number,
	idleTimeoutMs: number,
): ExportDownloadDeadline {
	let cleared = false;
	let responseUnavailable = false;
	let totalTimer: NodeJS.Timeout | null = null;
	let trackedBody:
		| Awaited<ReturnType<AuthService["openExportContent"]>>["body"]
		| null = null;

	const clear = () => {
		if (cleared) return;
		cleared = true;
		if (totalTimer !== null) {
			clearTimeout(totalTimer);
			totalTimer = null;
		}
		response.removeListener("finish", onResponseTerminated);
		response.removeListener("close", onResponseTerminated);
		response.removeListener("error", onResponseTerminated);
		response.removeListener("timeout", onTimeout);
		try {
			response.setTimeout(0);
		} catch {
			// The response may already have detached its socket.
		}
		trackedBody = null;
	};
	const destroyTrackedBody = () => {
		trackedBody?.destroy();
		trackedBody = null;
	};
	const onResponseTerminated = () => {
		responseUnavailable = true;
		destroyTrackedBody();
		clear();
	};
	const onTimeout = () => {
		if (cleared) return;
		responseUnavailable = true;
		destroyTrackedBody();
		clear();
		try {
			response.destroy();
		} catch {
			// A concurrently closed response is already unavailable.
		}
	};

	response.once("finish", onResponseTerminated);
	response.once("close", onResponseTerminated);
	response.once("error", onResponseTerminated);
	totalTimer = setTimeout(onTimeout, totalTimeoutMs);
	totalTimer.unref();
	try {
		response.setTimeout(idleTimeoutMs, onTimeout);
	} catch (error) {
		onTimeout();
		throw error;
	}
	if (
		response.destroyed === true ||
		response.closed === true ||
		response.writableEnded === true ||
		response.writableFinished === true
	) {
		onTimeout();
	}

	return Object.freeze({
		responseUnavailable: () => responseUnavailable,
		trackBody: (
			body: Awaited<ReturnType<AuthService["openExportContent"]>>["body"],
		) => {
			if (cleared || responseUnavailable) {
				body.destroy();
				return;
			}
			trackedBody?.destroy();
			trackedBody = body;
		},
		clear,
	});
}
