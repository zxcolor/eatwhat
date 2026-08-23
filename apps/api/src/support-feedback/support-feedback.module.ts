import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { SupportFeedbackController } from "./support-feedback.controller.js";
import { SupportFeedbackRepository } from "./support-feedback.repository.js";
import { SupportFeedbackService } from "./support-feedback.service.js";
import { SUPPORT_FEEDBACK_CONFIG } from "./support-feedback.tokens.js";
import { loadSupportFeedbackRuntimeConfig } from "./support-feedback-config.js";

@Module({
	imports: [AuthModule],
	controllers: [SupportFeedbackController],
	providers: [
		{
			provide: SUPPORT_FEEDBACK_CONFIG,
			inject: [APP_CONFIG],
			useFactory: (config: AppConfig) =>
				loadSupportFeedbackRuntimeConfig(process.env, {
					databaseEnabled: config.database.enabled,
				}),
		},
		SupportFeedbackRepository,
		SupportFeedbackService,
	],
	exports: [SupportFeedbackService],
})
export class SupportFeedbackModule {}
