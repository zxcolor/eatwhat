import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PersistenceRepository } from "./persistence.repository.js";
import {
	PersistenceCapabilityService,
	PersistenceCursorService,
} from "./persistence-support.js";
import { PersistenceUserService } from "./persistence-user.service.js";
import {
	AmapPlacePresentationAdapter,
	PERSISTENCE_FETCH,
	PlacePresentationResolver,
} from "./place-presentation.resolver.js";

@Module({
	imports: [AuthModule],
	providers: [
		PersistenceRepository,
		PersistenceCapabilityService,
		PersistenceCursorService,
		AmapPlacePresentationAdapter,
		PlacePresentationResolver,
		PersistenceUserService,
		{ provide: PERSISTENCE_FETCH, useValue: globalThis.fetch.bind(globalThis) },
	],
	exports: [
		PersistenceRepository,
		PersistenceCapabilityService,
		PersistenceCursorService,
		PlacePresentationResolver,
		PersistenceUserService,
	],
})
export class PersistenceModule {}
