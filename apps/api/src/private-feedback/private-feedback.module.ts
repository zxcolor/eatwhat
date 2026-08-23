import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module.js";
import { PrivateFeedbackController } from "./private-feedback.controller.js";
import { PrivateFeedbackService } from "./private-feedback.service.js";

@Module({
	imports: [PersistenceModule],
	controllers: [PrivateFeedbackController],
	providers: [PrivateFeedbackService],
})
export class PrivateFeedbackModule {}
