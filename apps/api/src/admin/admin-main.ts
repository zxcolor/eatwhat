import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { configureHttpRuntime } from "../common/http-runtime-security.js";
import { SafeExceptionFilter } from "../common/safe-exception.filter.js";
import { AdminAppModule } from "./admin-app.module.js";
import {
	ADMIN_PROCESS_CONFIG,
	type AdminProcessConfig,
} from "./admin-process-config.js";

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create<NestExpressApplication>(AdminAppModule, {
		logger: ["log", "warn", "error"],
		bodyParser: false,
	});
	app.useGlobalFilters(new SafeExceptionFilter());
	app.enableShutdownHooks();
	const config = app.get<AdminProcessConfig>(ADMIN_PROCESS_CONFIG);
	configureHttpRuntime(app, {
		trustedProxyCidrs: config.trustedProxyCidrs,
		auth: { enabled: false },
		admin: config.admin,
	});
	await app.listen(config.port, config.bindHost);
	new Logger("AdminBootstrap").log(
		`Administrator API listening on configured private interface port ${config.port}`,
	);
}

void bootstrap();
