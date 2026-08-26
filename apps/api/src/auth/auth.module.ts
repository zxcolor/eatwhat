import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { AppConfigModule } from "../config/app-config.module.js";
import { createAliyunOssExportArtifactStore } from "../data-export/aliyun-oss-export-artifact.store.js";
import { PrivateExportArtifactReader } from "../data-export/private-export-artifact.reader.js";
import { DatabaseModule } from "../database/database.module.js";
import { AccountController } from "./account.controller.js";
import { AuthController } from "./auth.controller.js";
import { AuthRepository, PostgresAuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { AuthAvailabilityGuard } from "./auth-availability.guard.js";
import {
	ALIYUN_CREDENTIAL,
	ALIYUN_FUSION_CLIENT,
	ALIYUN_SMS_CLIENT,
	createEmailOtpProvider,
	createFusionAuthProvider,
	createPhoneOtpProvider,
	createQqIdentityProvider,
	createWechatIdentityProvider,
	EMAIL_OTP_PROVIDER,
	FUSION_AUTH_PROVIDER,
	PHONE_OTP_PROVIDER,
	QQ_IDENTITY_PROVIDER,
	SMTP_CLIENT,
	WECHAT_IDENTITY_PROVIDER,
} from "./auth-provider.factories.js";
import { AuthRateLimitInterceptor } from "./auth-rate-limit.interceptor.js";
import {
	AUTHENTICATED_USER_RESOLVER,
	DatabaseAuthenticatedUserResolver,
} from "./authenticated-user.resolver.js";
import {
	EXPORT_ARTIFACT_READER,
	UnavailableExportArtifactReader,
} from "./data-export-artifact.reader.js";
import {
	createAliyunCredential,
	createOfficialAliyunFusionClient,
	createOfficialAliyunSmsClient,
} from "./providers/aliyun-official.clients.js";
import { createVerifiedSmtpTransportClient } from "./providers/smtp-email-otp.provider.js";

@Module({
	imports: [AppConfigModule, DatabaseModule],
	controllers: [AuthController, AccountController],
	providers: [
		AuthAvailabilityGuard,
		AuthRateLimitInterceptor,
		AuthService,
		{ provide: AuthRepository, useClass: PostgresAuthRepository },
		{
			provide: AUTHENTICATED_USER_RESOLVER,
			useClass: DatabaseAuthenticatedUserResolver,
		},
		{
			provide: EXPORT_ARTIFACT_READER,
			inject: [APP_CONFIG],
			useFactory: async (config: AppConfig) => {
				if (!config.auth.dataExportEnabled) {
					return new UnavailableExportArtifactReader();
				}
				const store = await createAliyunOssExportArtifactStore(
					config.dataExportArtifacts,
				);
				if (store === null) throw new Error("数据导出私有工件存储未就绪");
				return new PrivateExportArtifactReader(
					config.dataExportArtifacts,
					store,
				);
			},
		},
		{
			provide: ALIYUN_CREDENTIAL,
			inject: [APP_CONFIG],
			useFactory: (config: AppConfig) => createAliyunCredential(config),
		},
		{
			provide: ALIYUN_SMS_CLIENT,
			inject: [APP_CONFIG, ALIYUN_CREDENTIAL],
			useFactory: createOfficialAliyunSmsClient,
		},
		{
			provide: ALIYUN_FUSION_CLIENT,
			inject: [APP_CONFIG, ALIYUN_CREDENTIAL],
			useFactory: createOfficialAliyunFusionClient,
		},
		{
			provide: SMTP_CLIENT,
			inject: [APP_CONFIG],
			useFactory: (config: AppConfig) =>
				createVerifiedSmtpTransportClient(config.auth.email),
		},
		{
			provide: FUSION_AUTH_PROVIDER,
			inject: [APP_CONFIG, { token: ALIYUN_FUSION_CLIENT, optional: true }],
			useFactory: createFusionAuthProvider,
		},
		{
			provide: PHONE_OTP_PROVIDER,
			inject: [APP_CONFIG, { token: ALIYUN_SMS_CLIENT, optional: true }],
			useFactory: createPhoneOtpProvider,
		},
		{
			provide: EMAIL_OTP_PROVIDER,
			inject: [APP_CONFIG, { token: SMTP_CLIENT, optional: true }],
			useFactory: createEmailOtpProvider,
		},
		{
			provide: WECHAT_IDENTITY_PROVIDER,
			inject: [APP_CONFIG],
			useFactory: (config: AppConfig) => createWechatIdentityProvider(config),
		},
		{
			provide: QQ_IDENTITY_PROVIDER,
			inject: [APP_CONFIG],
			useFactory: (config: AppConfig) => createQqIdentityProvider(config),
		},
	],
	exports: [AUTHENTICATED_USER_RESOLVER],
})
export class AuthModule {}
