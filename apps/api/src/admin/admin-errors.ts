import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException,
} from "@nestjs/common";

export function adminUnavailable(): ServiceUnavailableException {
	return new ServiceUnavailableException({
		code: "ADMIN_API_UNAVAILABLE",
		message: "管理员服务暂时不可用",
	});
}

export function adminAuthenticationFailed(): UnauthorizedException {
	return new UnauthorizedException({
		code: "ADMIN_AUTHENTICATION_FAILED",
		message: "管理员认证失败",
	});
}

export function adminSessionInvalid(): UnauthorizedException {
	return new UnauthorizedException({
		code: "ADMIN_SESSION_INVALID",
		message: "管理员会话无效或已过期",
	});
}

export function adminForbidden(): ForbiddenException {
	return new ForbiddenException({
		code: "ADMIN_FORBIDDEN",
		message: "当前管理员没有执行此操作的权限",
	});
}

export function adminSecurityLocked(): HttpException {
	return new HttpException(
		{
			code: "ADMIN_SECURITY_LOCKED",
			message: "检测到凭据安全异常，管理员账号已锁定",
		},
		HttpStatus.LOCKED,
	);
}

export function adminCredentialConflict(): ConflictException {
	return new ConflictException({
		code: "ADMIN_CREDENTIAL_CONFLICT",
		message: "该管理员凭据已存在或凭据数量已达到上限",
	});
}

export function adminLastCredentialConflict(): ConflictException {
	return new ConflictException({
		code: "ADMIN_LAST_CREDENTIAL",
		message: "不能删除最后一枚有效管理员凭据",
	});
}

export function adminCredentialNotFound(): NotFoundException {
	return new NotFoundException({
		code: "ADMIN_CREDENTIAL_NOT_FOUND",
		message: "管理员凭据不存在",
	});
}

export function invalidAdminConfigRequest(): BadRequestException {
	return new BadRequestException({
		code: "INVALID_REQUEST",
		message: "配置值与配置键不符合接口约定",
	});
}

export function adminConfigVersionConflict(): ConflictException {
	return new ConflictException({
		code: "ADMIN_CONFIG_VERSION_CONFLICT",
		message: "配置已被其他管理员更新，请刷新后重试",
	});
}

export function adminConfigVersionNotFound(): NotFoundException {
	return new NotFoundException({
		code: "ADMIN_CONFIG_VERSION_NOT_FOUND",
		message: "要回滚到的配置版本不存在",
	});
}

export function adminClientReleaseUnverified(): ConflictException {
	return new ConflictException({
		code: "CLIENT_RELEASE_UNVERIFIED",
		message:
			"尚未接入可信客户端发布清单，不能首次设置、提高最低版本或新增平台门槛",
	});
}

export function invalidAdminCursor(): BadRequestException {
	return new BadRequestException({
		code: "INVALID_ADMIN_CURSOR",
		message: "管理员审计分页游标无效或已过期",
	});
}
