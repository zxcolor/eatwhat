import { Global, Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { OperationalConfigService } from "./operational-config.service.js";

@Global()
@Module({
	imports: [DatabaseModule],
	providers: [OperationalConfigService],
	exports: [OperationalConfigService],
})
export class OperationalConfigModule {}
