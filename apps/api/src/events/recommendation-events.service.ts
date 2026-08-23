import { randomUUID } from "node:crypto";
import type {
	DataSourceCode,
	RecommendationEvent,
} from "@chi-shen-me/contracts";
import { BadRequestException, Injectable } from "@nestjs/common";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import { HistoryPersistenceWriter } from "../history/history.service.js";
import { PersistenceUserService } from "../persistence/persistence-user.service.js";

interface StoredRecommendationEvent {
	readonly eventId: string;
	readonly requestId: string;
	readonly provider: DataSourceCode;
	readonly type: RecommendationEvent["type"];
	readonly occurredAt: string;
	readonly acceptedAt: string;
}

@Injectable()
export class RecommendationEventsService {
	private readonly events: StoredRecommendationEvent[] = [];
	private readonly maximumBufferedEvents = 10_000;
	private readonly retentionMs = 90 * 24 * 60 * 60 * 1_000;

	constructor(
		private readonly requestRegistry: RecommendationRequestRegistry,
		private readonly users: PersistenceUserService,
		private readonly history: HistoryPersistenceWriter,
	) {}

	async accept(
		event: RecommendationEvent,
		authorization?: string,
	): Promise<{ eventId: string; accepted: true }> {
		const authenticated =
			authorization === undefined
				? null
				: await this.users.resolve(authorization);
		const historyReference =
			authenticated === null
				? null
				: this.requestRegistry.resolveHistoryEvent(event);
		if (authenticated !== null && historyReference === null) {
			throw new BadRequestException({
				code: "INVALID_EVENT_SESSION",
				message: "推荐事件已过期、重复或不属于本次推荐",
			});
		}
		const reference = this.requestRegistry.validateAndConsume(event);
		if (reference === null) {
			throw new BadRequestException({
				code: "INVALID_EVENT_SESSION",
				message: "推荐事件已过期、重复或不属于本次推荐",
			});
		}
		if (authenticated !== null && historyReference !== null) {
			try {
				await this.history.record(
					authenticated.userId,
					event,
					historyReference,
				);
			} catch (error) {
				this.requestRegistry.releaseEventConsumption(event);
				throw error;
			}
		}
		this.purgeExpired();
		const eventId = randomUUID();
		// 逐字段复制，确保未来 DTO 变化时也不会意外把坐标或请求体原样留存。
		this.events.push({
			eventId,
			requestId: event.requestId,
			// Provider identity and stable place reference are resolved exclusively
			// from the server-side token mapping, never trusted from client input.
			provider: reference.provider,
			// This aggregate-only buffer never retains a stable provider place ID,
			// even while a persistence grant is active. Cross-device history/favorites
			// must use the database SECURITY DEFINER persistence function and retain
			// only its internal UUID; an in-memory grant check is not persistence.
			type: event.type,
			occurredAt: event.occurredAt,
			acceptedAt: new Date().toISOString(),
		});
		if (this.events.length > this.maximumBufferedEvents) this.events.shift();
		return { eventId, accepted: true };
	}

	/** 仅供测试和未来持久化适配器读取，返回不可变副本。 */
	snapshot(): readonly Readonly<StoredRecommendationEvent>[] {
		this.purgeExpired();
		return this.events.map((event) => Object.freeze({ ...event }));
	}

	private purgeExpired(): void {
		const cutoff = Date.now() - this.retentionMs;
		const firstRetainedIndex = this.events.findIndex(
			(event) => Date.parse(event.acceptedAt) >= cutoff,
		);
		if (firstRetainedIndex > 0) this.events.splice(0, firstRetainedIndex);
		if (firstRetainedIndex === -1 && this.events.length > 0)
			this.events.splice(0);
	}
}
