import { Global, Module } from "@nestjs/common";
import { AppConfigModule } from "../config/app-config.module.js";
import { DataRightsPolicy } from "../config/data-rights-policy.js";
import {
	DATABASE_POOL_FACTORY,
	DatabasePool,
	systemDatabasePoolFactory,
} from "./database-pool.js";

@Global()
@Module({
	imports: [AppConfigModule],
	providers: [
		{ provide: DATABASE_POOL_FACTORY, useValue: systemDatabasePoolFactory },
		DatabasePool,
		DataRightsPolicy,
	],
	exports: [DatabasePool, DataRightsPolicy],
})
export class DatabaseModule {}
