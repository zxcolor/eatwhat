import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureHttpRuntime } from "./common/http-runtime-security.js";
import { SafeExceptionFilter } from "./common/safe-exception.filter.js";
import { APP_CONFIG, type AppConfig } from "./config/app-config.js";

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create<NestExpressApplication>(AppModule, {
		logger: ["log", "warn", "error"],
		bodyParser: false,
	});
	app.useGlobalFilters(new SafeExceptionFilter());
	app.enableShutdownHooks();
	const config = app.get<AppConfig>(APP_CONFIG);
	configureHttpRuntime(app, config);
	await app.listen(config.port, "0.0.0.0");
	new Logger("Bootstrap").log(`API listening on port ${config.port}`);
}

void bootstrap();
