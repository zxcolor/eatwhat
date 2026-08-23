import { Module } from "@nestjs/common";
import { HistoryModule } from "../history/history.module.js";
import { PersistenceModule } from "../persistence/persistence.module.js";
import { RecommendationEventsController } from "./recommendation-events.controller.js";
import { RecommendationEventsService } from "./recommendation-events.service.js";

@Module({
	imports: [HistoryModule, PersistenceModule],
	controllers: [RecommendationEventsController],
	providers: [RecommendationEventsService],
})
export class RecommendationEventsModule {}
