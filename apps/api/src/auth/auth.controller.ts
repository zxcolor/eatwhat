import {
	type BindIdentityRequest,
	BindIdentityRequestSchema,
	type BindingIdPath,
	BindingIdPathSchema,
	type EmailRequestCode,
	EmailRequestCodeSchema,
	type LoginRequest,
	type ListSessionsQuery,
	ListSessionsQuerySchema,
	LoginRequestSchema,
	type LogoutRequest,
	LogoutRequestSchema,
	type OAuthStateRequest,
	OAuthStateRequestSchema,
	type PhoneRequestCode,
	PhoneRequestCodeSchema,
	type RefreshRequest,
	RefreshRequestSchema,
	type SessionIdPath,
	SessionIdPathSchema,
	type WechatMiniProgramLoginRequest,
	WechatMiniProgramLoginRequestSchema,
} from "@chi-shen-me/contracts";
import {
	Body,
	Controller,
	Delete,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Ip,
	Param,
	Post,
	Query,
	UseGuards,
	UseInterceptors,
} from "@nestjs/common";
import { RateLimit } from "../common/ip-rate-limit.guard.js";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { AuthService } from "./auth.service.js";
import { AuthAvailabilityGuard } from "./auth-availability.guard.js";
import { AuthRateLimitInterceptor } from "./auth-rate-limit.interceptor.js";
import {
	optionalBearerAccessToken,
	requireBearerAccessToken,
} from "./bearer-token.js";

function flowBearer(
	purpose: "REGISTER" | "LOGIN" | "BIND",
	header: unknown,
): string | null {
	return purpose === "BIND"
		? requireBearerAccessToken(header)
		: optionalBearerAccessToken(header);
}

@Controller("v1/auth")
@UseGuards(AuthAvailabilityGuard)
@UseInterceptors(AuthRateLimitInterceptor)
export class AuthController {
	constructor(private readonly service: AuthService) {}

	@Post("phone/request-code")
	@HttpCode(HttpStatus.ACCEPTED)
	@RateLimit(5, 60_000)
	requestPhoneCode(
		@Body(new ZodBodyPipe(PhoneRequestCodeSchema)) input: PhoneRequestCode,
		@Headers("authorization") authorization: string | undefined,
		@Ip() clientIp: string,
	) {
		return this.service.requestPhoneCode(
			input,
			flowBearer(input.purpose, authorization),
			clientIp,
		);
	}

	@Post("email/request-code")
	@HttpCode(HttpStatus.ACCEPTED)
	@RateLimit(5, 60_000)
	requestEmailCode(
		@Body(new ZodBodyPipe(EmailRequestCodeSchema)) input: EmailRequestCode,
		@Headers("authorization") authorization: string | undefined,
		@Ip() clientIp: string,
	) {
		return this.service.requestEmailCode(
			input,
			flowBearer(input.purpose, authorization),
			clientIp,
		);
	}

	@Post("oauth/state")
	@HttpCode(HttpStatus.CREATED)
	@RateLimit(20, 60_000)
	createOAuthState(
		@Body(new ZodBodyPipe(OAuthStateRequestSchema)) input: OAuthStateRequest,
		@Headers("authorization") authorization: string | undefined,
		@Ip() clientIp: string,
	) {
		const bearer =
			input.purpose === "BIND"
				? requireBearerAccessToken(authorization)
				: optionalBearerAccessToken(authorization);
		return this.service.createOAuthState(input, bearer, clientIp);
	}

	@Post("login")
	@HttpCode(HttpStatus.OK)
	@RateLimit(10, 60_000)
	login(
		@Body(new ZodBodyPipe(LoginRequestSchema)) input: LoginRequest,
		@Ip() clientIp: string,
	) {
		return this.service.login(input, clientIp);
	}

	@Post("wechat-miniprogram/login")
	@HttpCode(HttpStatus.OK)
	@RateLimit(10, 60_000)
	loginWechatMiniProgram(
		@Body(new ZodBodyPipe(WechatMiniProgramLoginRequestSchema))
		input: WechatMiniProgramLoginRequest,
		@Ip() clientIp: string,
	) {
		return this.service.loginWechatMiniProgram(input, clientIp);
	}

	@Post("refresh")
	@HttpCode(HttpStatus.OK)
	@RateLimit(30, 60_000)
	refresh(
		@Body(new ZodBodyPipe(RefreshRequestSchema)) input: RefreshRequest,
		@Ip() clientIp: string,
	) {
		return this.service.refresh(input, clientIp);
	}

	@Post("logout")
	@HttpCode(HttpStatus.OK)
	@RateLimit(30, 60_000)
	logout(
		@Body(new ZodBodyPipe(LogoutRequestSchema)) _input: LogoutRequest,
		@Headers("authorization") authorization: string | undefined,
	) {
		return this.service.logout(requireBearerAccessToken(authorization));
	}

	@Get("identities")
	@HttpCode(HttpStatus.OK)
	@RateLimit(30, 60_000)
	listIdentities(@Headers("authorization") authorization: string | undefined) {
		return this.service.listIdentities(requireBearerAccessToken(authorization));
	}

	@Post("identities")
	@HttpCode(HttpStatus.CREATED)
	@RateLimit(20, 60_000)
	bindIdentity(
		@Body(new ZodBodyPipe(BindIdentityRequestSchema))
		input: BindIdentityRequest,
		@Headers("authorization") authorization: string | undefined,
	) {
		return this.service.bindIdentity(
			requireBearerAccessToken(authorization),
			input,
		);
	}

	@Delete("identities/:bindingId")
	@HttpCode(HttpStatus.OK)
	@RateLimit(20, 60_000)
	unbindIdentity(
		@Param(new ZodBodyPipe(BindingIdPathSchema)) path: BindingIdPath,
		@Headers("authorization") authorization: string | undefined,
	) {
		return this.service.unbindIdentity(
			requireBearerAccessToken(authorization),
			path.bindingId,
		);
	}

	@Get("sessions")
	@HttpCode(HttpStatus.OK)
	@RateLimit(30, 60_000)
	listSessions(
		@Headers("authorization") authorization: string | undefined,
		@Query(new ZodBodyPipe(ListSessionsQuerySchema)) query: ListSessionsQuery,
	) {
		return this.service.listSessions(
			requireBearerAccessToken(authorization),
			query,
		);
	}

	@Delete("sessions/:sessionId")
	@HttpCode(HttpStatus.OK)
	@RateLimit(20, 60_000)
	revokeSession(
		@Param(new ZodBodyPipe(SessionIdPathSchema)) path: SessionIdPath,
		@Headers("authorization") authorization: string | undefined,
	) {
		return this.service.revokeSession(
			requireBearerAccessToken(authorization),
			path.sessionId,
		);
	}
}
