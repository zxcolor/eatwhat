import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller.js";
import {
	AdminApiEnabledGuard,
	AdminPermissionGuard,
	AdminRateLimitGuard,
	AdminSessionGuard,
} from "./admin.guards.js";
import { AdminRepository } from "./admin.repository.js";
import {
	AdminAuditService,
	AdminCredentialsService,
	AdminLoginService,
	AdminSessionService,
} from "./admin.services.js";
import { AdminAuditCursorService } from "./admin-audit-cursor.js";
import { AdminCrypto } from "./admin-crypto.js";
import {
	ADMIN_DATABASE_POOL_FACTORY,
	AdminDatabasePool,
	systemAdminDatabasePoolFactory,
} from "./admin-database.pool.js";
import { AdminProcessConfigModule } from "./admin-process-config.module.js";
import { AdminRequestContextFactory } from "./admin-request-context.js";
import { AdminWebAuthnAdapter } from "./admin-webauthn.adapter.js";

@Module({
	imports: [AdminProcessConfigModule],
	controllers: [AdminController],
	providers: [
		{
			provide: ADMIN_DATABASE_POOL_FACTORY,
			useValue: systemAdminDatabasePoolFactory,
		},
		AdminDatabasePool,
		AdminCrypto,
		AdminRequestContextFactory,
		AdminRepository,
		AdminWebAuthnAdapter,
		AdminAuditCursorService,
		AdminLoginService,
		AdminSessionService,
		AdminCredentialsService,
		AdminAuditService,
		AdminApiEnabledGuard,
		AdminRateLimitGuard,
		AdminSessionGuard,
		AdminPermissionGuard,
	],
})
export class AdminModule {}
