import {
	type AdminAuditQuery,
	AdminAuditQuerySchema,
	type AdminConfigHistoryQuery,
	AdminConfigHistoryQuerySchema,
	type AdminConfigPath,
	AdminConfigPathSchema,
	type AdminConfigPublishRequest,
	AdminConfigPublishRequestSchema,
	type AdminConfigRollbackRequest,
	AdminConfigRollbackRequestSchema,
	type AdminCredentialEnrollVerifyRequest,
	AdminCredentialEnrollVerifyRequestSchema,
	type AdminCredentialPath,
	AdminCredentialPathSchema,
	type AdminEmptyMutationRequest,
	AdminEmptyMutationRequestSchema,
	type AdminLoginOptionsRequest,
	AdminLoginOptionsRequestSchema,
	type AdminLoginVerifyRequest,
	AdminLoginVerifyRequestSchema,
} from "@chi-shen-me/contracts";
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	Post,
	Put,
	Query,
	Req,
	UseGuards,
} from "@nestjs/common";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import {
	ADMIN_PRINCIPAL,
	AdminApiEnabledGuard,
	AdminPermissionGuard,
	AdminRateLimit,
	AdminRateLimitGuard,
	AdminSessionGuard,
	type AuthenticatedAdminHttpRequest,
	RequireAdminPermission,
} from "./admin.guards.js";
import {
	AdminAuditService,
	AdminConfigurationService,
	AdminCredentialsService,
	AdminLoginService,
	AdminSessionService,
} from "./admin.services.js";
import type { AdminHttpRequest } from "./admin-request-context.js";

function principal(request: AuthenticatedAdminHttpRequest) {
	const value = request[ADMIN_PRINCIPAL];
	if (value === undefined) throw new Error("管理员会话上下文缺失");
	return value;
}

@Controller("admin/v1")
@UseGuards(AdminApiEnabledGuard, AdminRateLimitGuard)
export class AdminController {
	constructor(
		private readonly login: AdminLoginService,
		private readonly sessions: AdminSessionService,
		private readonly credentials: AdminCredentialsService,
		private readonly audit: AdminAuditService,
		private readonly configuration: AdminConfigurationService,
	) {}

	@Post("auth/login/options")
	@AdminRateLimit(5, 10 * 60_000)
	@HttpCode(HttpStatus.OK)
	loginOptions(
		@Req() request: AdminHttpRequest,
		@Body(new ZodBodyPipe(AdminLoginOptionsRequestSchema))
		input: AdminLoginOptionsRequest,
	) {
		return this.login.options(request, input);
	}

	@Post("auth/login/verify")
	@AdminRateLimit(10, 10 * 60_000)
	@HttpCode(HttpStatus.OK)
	loginVerify(
		@Req() request: AdminHttpRequest,
		@Body(new ZodBodyPipe(AdminLoginVerifyRequestSchema))
		input: AdminLoginVerifyRequest,
	) {
		return this.login.verify(request, input);
	}

	@Get("session")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@AdminRateLimit(60, 60_000)
	currentSession(@Req() request: AuthenticatedAdminHttpRequest) {
		return this.sessions.current(principal(request));
	}

	@Post("session/logout")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@AdminRateLimit(20, 60_000)
	@HttpCode(HttpStatus.NO_CONTENT)
	async logout(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Body(new ZodBodyPipe(AdminEmptyMutationRequestSchema))
		_input: AdminEmptyMutationRequest,
	): Promise<void> {
		await this.sessions.logout(principal(request));
	}

	@Get("credentials")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("CREDENTIAL_SELF_MANAGE")
	@AdminRateLimit(30, 60_000)
	listCredentials(@Req() request: AuthenticatedAdminHttpRequest) {
		return this.credentials.list(principal(request));
	}

	@Post("credentials/enroll/options")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("CREDENTIAL_SELF_MANAGE")
	@AdminRateLimit(5, 10 * 60_000)
	@HttpCode(HttpStatus.OK)
	enrollOptions(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Body(new ZodBodyPipe(AdminEmptyMutationRequestSchema))
		_input: AdminEmptyMutationRequest,
	) {
		return this.credentials.options(principal(request));
	}

	@Post("credentials/enroll/verify")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("CREDENTIAL_SELF_MANAGE")
	@AdminRateLimit(10, 10 * 60_000)
	@HttpCode(HttpStatus.CREATED)
	enrollVerify(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Body(new ZodBodyPipe(AdminCredentialEnrollVerifyRequestSchema))
		input: AdminCredentialEnrollVerifyRequest,
	) {
		return this.credentials.verify(principal(request), input);
	}

	@Delete("credentials/:credentialHandle")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("CREDENTIAL_SELF_MANAGE")
	@AdminRateLimit(10, 60_000)
	@HttpCode(HttpStatus.NO_CONTENT)
	async revokeCredential(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Param(new ZodBodyPipe(AdminCredentialPathSchema))
		path: AdminCredentialPath,
	): Promise<void> {
		await this.credentials.revoke(principal(request), path.credentialHandle);
	}

	@Get("audit")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("AUDIT_READ")
	@AdminRateLimit(30, 60_000)
	listAudit(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Query(new ZodBodyPipe(AdminAuditQuerySchema)) query: AdminAuditQuery,
	) {
		return this.audit.list(principal(request), query);
	}

	@Get("configuration")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("ALGORITHM_CONFIG_READ")
	@AdminRateLimit(60, 60_000)
	listConfiguration(@Req() request: AuthenticatedAdminHttpRequest) {
		return this.configuration.list(principal(request));
	}

	@Get("configuration/:configKey/history")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("ALGORITHM_CONFIG_READ")
	@AdminRateLimit(30, 60_000)
	configurationHistory(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Param(new ZodBodyPipe(AdminConfigPathSchema)) path: AdminConfigPath,
		@Query(new ZodBodyPipe(AdminConfigHistoryQuerySchema))
		query: AdminConfigHistoryQuery,
	) {
		return this.configuration.history(
			principal(request),
			path.configKey,
			query,
		);
	}

	@Put("configuration/:configKey")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("ALGORITHM_CONFIG_WRITE")
	@AdminRateLimit(12, 60_000)
	updateConfiguration(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Param(new ZodBodyPipe(AdminConfigPathSchema)) path: AdminConfigPath,
		@Body(new ZodBodyPipe(AdminConfigPublishRequestSchema))
		input: AdminConfigPublishRequest,
	) {
		return this.configuration.publish(
			principal(request),
			path.configKey,
			input,
		);
	}

	@Post("configuration/:configKey/rollback")
	@UseGuards(AdminSessionGuard, AdminPermissionGuard)
	@RequireAdminPermission("ALGORITHM_CONFIG_WRITE")
	@AdminRateLimit(6, 60_000)
	@HttpCode(HttpStatus.OK)
	rollbackConfiguration(
		@Req() request: AuthenticatedAdminHttpRequest,
		@Param(new ZodBodyPipe(AdminConfigPathSchema)) path: AdminConfigPath,
		@Body(new ZodBodyPipe(AdminConfigRollbackRequestSchema))
		input: AdminConfigRollbackRequest,
	) {
		return this.configuration.rollback(
			principal(request),
			path.configKey,
			input,
		);
	}
}
