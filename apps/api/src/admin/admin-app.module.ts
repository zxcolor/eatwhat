import { Module } from "@nestjs/common";
import { AdminModule } from "./admin.module.js";

@Module({ imports: [AdminModule] })
export class AdminAppModule {}
