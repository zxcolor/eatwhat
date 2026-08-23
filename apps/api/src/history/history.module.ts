import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module.js";
import { HistoryController } from "./history.controller.js";
import { HistoryPersistenceWriter, HistoryService } from "./history.service.js";

@Module({
	imports: [PersistenceModule],
	controllers: [HistoryController],
	providers: [HistoryService, HistoryPersistenceWriter],
	exports: [HistoryPersistenceWriter],
})
export class HistoryModule {}
