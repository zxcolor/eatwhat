import { Global, Module } from "@nestjs/common";
import {
	ADMIN_PROCESS_CONFIG,
	loadAdminProcessConfig,
} from "./admin-process-config.js";

@Global()
@Module({
	providers: [
		{
			provide: ADMIN_PROCESS_CONFIG,
			useFactory: () => loadAdminProcessConfig(),
		},
	],
	exports: [ADMIN_PROCESS_CONFIG],
})
export class AdminProcessConfigModule {}
