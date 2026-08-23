import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module.js";
import { FavoritesController } from "./favorites.controller.js";
import { FavoritesService } from "./favorites.service.js";

@Module({
	imports: [PersistenceModule],
	controllers: [FavoritesController],
	providers: [FavoritesService],
})
export class FavoritesModule {}
