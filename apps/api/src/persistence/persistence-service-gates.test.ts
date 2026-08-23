import type {
	CreatePrivateFeedbackRequest,
	FavoriteMutationRequest,
	RecommendationEvent,
} from "@chi-shen-me/contracts";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import { FavoritesController } from "../favorites/favorites.controller.js";
import { FavoritesService } from "../favorites/favorites.service.js";
import {
	HistoryPersistenceWriter,
	HistoryService,
} from "../history/history.service.js";
import { PrivateFeedbackController } from "../private-feedback/private-feedback.controller.js";
import { PrivateFeedbackService } from "../private-feedback/private-feedback.service.js";
import type { PersistenceRepository } from "./persistence.repository.js";
import {
	type PersistenceCapabilityService,
	type PersistenceCursorService,
	persistenceForbidden,
} from "./persistence-support.js";
import type { PersistenceUserService } from "./persistence-user.service.js";
import type { PlacePresentationResolver } from "./place-presentation.resolver.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const RESULT_TOKEN = "a".repeat(43);

const favoriteInput: FavoriteMutationRequest = {
	idempotencyKey: IDEMPOTENCY_KEY,
	result: { requestId: REQUEST_ID, resultToken: RESULT_TOKEN },
	group: "WANT_TO_GO",
};

const feedbackInput: CreatePrivateFeedbackRequest = {
	idempotencyKey: IDEMPOTENCY_KEY,
	result: { requestId: REQUEST_ID, resultToken: RESULT_TOKEN },
	type: "LIKE",
};

const event: RecommendationEvent = {
	requestId: REQUEST_ID,
	resultToken: RESULT_TOKEN,
	type: "DETAIL",
	occurredAt: "2026-08-21T08:00:00.000Z",
};

function boundary() {
	const users = {
		resolve: vi.fn().mockResolvedValue({
			userId: USER_ID,
			sessionId: "55555555-5555-4555-8555-555555555555",
			deviceHash: "0".repeat(64),
		}),
	};
	const registry = {
		resolveForPersistence: vi.fn().mockReturnValue({
			provider: "AMAP",
			providerPlaceId: "private-place-reference",
			mealPeriod: "LUNCH",
		}),
	};
	const capability = {
		requireDeploymentCapability: vi.fn(() => {
			throw persistenceForbidden();
		}),
		requireGrant: vi.fn().mockRejectedValue(persistenceForbidden()),
	};
	const repository = {
		isAvailable: vi.fn().mockReturnValue(true),
		createFavorite: vi.fn(),
		updateFavoriteGroup: vi.fn(),
		listFavorites: vi.fn().mockResolvedValue([]),
		deleteFavorite: vi.fn().mockResolvedValue(undefined),
		recordHistory: vi.fn(),
		listHistory: vi.fn().mockResolvedValue([]),
		clearHistory: vi.fn().mockResolvedValue(undefined),
		createFeedback: vi.fn(),
		listFeedback: vi.fn().mockResolvedValue([]),
		deleteFeedback: vi.fn().mockResolvedValue(undefined),
		clearFeedback: vi.fn().mockResolvedValue(undefined),
	};
	const cursors = {
		resolve: vi.fn().mockReturnValue(null),
		issue: vi.fn(),
	};
	const presentations = {
		resolveAll: vi.fn().mockResolvedValue([]),
	};
	return {
		users,
		registry,
		capability,
		repository,
		cursors,
		presentations,
	};
}

function favorites(parts: ReturnType<typeof boundary>): FavoritesService {
	return new FavoritesService(
		parts.users as unknown as PersistenceUserService,
		parts.registry as unknown as RecommendationRequestRegistry,
		parts.capability as unknown as PersistenceCapabilityService,
		parts.repository as unknown as PersistenceRepository,
		parts.cursors as unknown as PersistenceCursorService,
		parts.presentations as unknown as PlacePresentationResolver,
	);
}

function feedback(parts: ReturnType<typeof boundary>): PrivateFeedbackService {
	return new PrivateFeedbackService(
		parts.users as unknown as PersistenceUserService,
		parts.registry as unknown as RecommendationRequestRegistry,
		parts.capability as unknown as PersistenceCapabilityService,
		parts.repository as unknown as PersistenceRepository,
		parts.cursors as unknown as PersistenceCursorService,
		parts.presentations as unknown as PlacePresentationResolver,
	);
}

async function expectCapabilityForbidden(promise: Promise<unknown>) {
	await expect(promise).rejects.toMatchObject({
		constructor: ForbiddenException,
		response: {
			code: "PERSISTENCE_CAPABILITY_DISABLED",
			message: "当前数据授权不允许保存餐厅引用",
		},
	});
}

describe("persistence write gates", () => {
	it("blocks a direct favorite POST at the service boundary", async () => {
		const parts = boundary();
		const controller = new FavoritesController(favorites(parts));

		await expectCapabilityForbidden(
			controller.create("Bearer private-access-token", favoriteInput),
		);
		expect(parts.capability.requireGrant).toHaveBeenCalledWith(
			"FAVORITE",
			"AMAP",
		);
		expect(parts.repository.createFavorite).not.toHaveBeenCalled();
	});

	it("blocks a direct private-feedback POST at the service boundary", async () => {
		const parts = boundary();
		const controller = new PrivateFeedbackController(feedback(parts));

		await expectCapabilityForbidden(
			controller.create("Bearer private-access-token", feedbackInput),
		);
		expect(parts.capability.requireGrant).toHaveBeenCalledWith(
			"PRIVATE_FEEDBACK",
			"AMAP",
		);
		expect(parts.repository.createFeedback).not.toHaveBeenCalled();
	});

	it("blocks history writes with the history-specific capability", async () => {
		const parts = boundary();
		const writer = new HistoryPersistenceWriter(
			parts.capability as unknown as PersistenceCapabilityService,
			parts.repository as unknown as PersistenceRepository,
		);

		await expectCapabilityForbidden(
			writer.record(USER_ID, event, {
				provider: "AMAP",
				providerPlaceId: "private-place-reference",
				mealPeriod: "LUNCH",
			}),
		);
		expect(parts.capability.requireGrant).toHaveBeenCalledWith(
			"HISTORY",
			"AMAP",
		);
		expect(parts.repository.recordHistory).not.toHaveBeenCalled();
	});

	it("makes favorite group updates read-only when creation is disabled", async () => {
		const parts = boundary();
		const service = favorites(parts);

		await expectCapabilityForbidden(
			service.updateGroup("Bearer private-access-token", RESOURCE_ID, {
				idempotencyKey: IDEMPOTENCY_KEY,
				group: "REGULAR",
			}),
		);
		expect(parts.capability.requireDeploymentCapability).toHaveBeenCalledWith(
			"FAVORITE",
		);
		expect(parts.repository.updateFavoriteGroup).not.toHaveBeenCalled();
	});
});

describe("persistence user data rights", () => {
	it("allows favorite list and delete after creation is disabled or revoked", async () => {
		const parts = boundary();
		const service = favorites(parts);

		await expect(
			service.list("Bearer private-access-token", { limit: 20 }),
		).resolves.toEqual({ items: [], nextCursor: null });
		await expect(
			service.delete("Bearer private-access-token", RESOURCE_ID),
		).resolves.toBeUndefined();
		expect(parts.capability.requireGrant).not.toHaveBeenCalled();
		expect(parts.capability.requireDeploymentCapability).not.toHaveBeenCalled();
	});

	it("allows history list and clear after history writes are disabled", async () => {
		const parts = boundary();
		const service = new HistoryService(
			parts.users as unknown as PersistenceUserService,
			parts.repository as unknown as PersistenceRepository,
			parts.cursors as unknown as PersistenceCursorService,
			parts.presentations as unknown as PlacePresentationResolver,
		);

		await expect(
			service.list("Bearer private-access-token", { limit: 20 }),
		).resolves.toEqual({ items: [], nextCursor: null, retentionDays: 90 });
		await expect(
			service.clear("Bearer private-access-token"),
		).resolves.toBeUndefined();
		expect(parts.capability.requireGrant).not.toHaveBeenCalled();
		expect(parts.repository.clearHistory).toHaveBeenCalledWith(USER_ID);
	});

	it("allows private-feedback list, delete and clear after writes are disabled", async () => {
		const parts = boundary();
		const service = feedback(parts);

		await expect(
			service.list("Bearer private-access-token", { limit: 20 }),
		).resolves.toEqual({ items: [], nextCursor: null });
		await expect(
			service.delete("Bearer private-access-token", RESOURCE_ID),
		).resolves.toBeUndefined();
		await expect(
			service.clear("Bearer private-access-token"),
		).resolves.toBeUndefined();
		expect(parts.capability.requireGrant).not.toHaveBeenCalled();
		expect(parts.repository.deleteFeedback).toHaveBeenCalledWith(
			USER_ID,
			RESOURCE_ID,
		);
	});
});
