import {
	Controller,
	Get,
	Inject,
	ServiceUnavailableException,
} from "@nestjs/common";
import { DatabasePool } from "../database/database-pool.js";
import {
	PLACE_PROVIDER,
	type PlaceProvider,
} from "../recommendations/domain/place-candidate.js";

@Controller("health")
export class HealthController {
	constructor(
		private readonly database: DatabasePool,
		@Inject(PLACE_PROVIDER) private readonly places: PlaceProvider,
	) {}

	@Get()
	check(): { status: "ok"; timestamp: string } {
		return { status: "ok", timestamp: new Date().toISOString() };
	}

	@Get("ready")
	async ready(): Promise<{ status: "ready"; timestamp: string }> {
		let databaseReady = false;
		try {
			databaseReady = await this.database.isReady();
		} catch {
			// A probe implementation failure is still only "not ready" publicly.
		}
		let recommendationProviderReady = false;
		try {
			recommendationProviderReady = this.places.kind !== "UNAVAILABLE";
		} catch {
			// Provider internals and failure reasons never cross this boundary.
		}
		if (!databaseReady || !recommendationProviderReady) {
			throw new ServiceUnavailableException({
				code: "SERVICE_NOT_READY",
				message: "服务尚未就绪，请稍后重试",
			});
		}
		return { status: "ready", timestamp: new Date().toISOString() };
	}
}
