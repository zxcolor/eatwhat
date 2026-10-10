import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../core/api-client";
import { PrivacyConsentAuthority } from "../consent/consent-authority";
import type { SavedResourcesApi } from "./saved-resources";
import { SavedResourcesService } from "./saved-resources";

class MemoryStorage {
	readonly values = new Map<string, unknown>();
	getStorageSync(key: string): unknown {
		return this.values.get(key);
	}
	setStorageSync(key: string, value: unknown): void {
		this.values.set(key, value);
	}
	removeStorageSync(key: string): void {
		this.values.delete(key);
	}
}

function scenario() {
	const listFavorites = vi
		.fn()
		.mockResolvedValue({ items: [], nextCursor: null });
	const api = { listFavorites } as unknown as SavedResourcesApi;
	const storage = new MemoryStorage();
	const consent = new PrivacyConsentAuthority(storage);
	const accessToken = vi.fn().mockResolvedValue("a".repeat(43));
	const invalidate = vi.fn();
	const createUuid = vi
		.fn()
		.mockResolvedValue("33333333-3333-4333-8333-333333333333");
	const service = new SavedResourcesService(
		api,
		{ accessToken, invalidate },
		consent,
		() => ({
			favoritesEnabled: true,
			historyEnabled: true,
			privateFeedbackEnabled: true,
			savedResourceIdsEnabled: false,
		}),
		createUuid,
	);
	return {
		service,
		consent,
		listFavorites,
		accessToken,
		invalidate,
		createUuid,
	};
}

const LIVE_LICENSED_REFERENCE = Object.freeze({
	requestId: "11111111-1111-4111-8111-111111111111",
	resultToken: "a".repeat(43),
	dataMode: "LIVE" as const,
	dataRightsMode: "LICENSED_ENRICHMENT" as const,
});

describe("SavedResourcesService", () => {
	it("does not acquire a token or call the API before privacy consent", async () => {
		const { service, listFavorites, accessToken } = scenario();
		await expect(service.listFavorites()).resolves.toMatchObject({
			ok: false,
			kind: "PRIVACY_REQUIRED",
		});
		expect(accessToken).not.toHaveBeenCalled();
		expect(listFavorites).not.toHaveBeenCalled();
	});

	it("uses the current access token only after consent and capability checks", async () => {
		const { service, consent, listFavorites } = scenario();
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		await expect(service.listFavorites()).resolves.toEqual({
			ok: true,
			value: { items: [], nextCursor: null },
		});
		expect(listFavorites).toHaveBeenCalledWith("a".repeat(43), undefined);
	});

	it("returns a retryable network outcome when refreshing the access token fails", async () => {
		const { service, consent, listFavorites, accessToken, invalidate } =
			scenario();
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		accessToken.mockRejectedValueOnce(new ApiError("NETWORK"));

		await expect(service.listFavorites()).resolves.toMatchObject({
			ok: false,
			kind: "NETWORK",
		});
		expect(listFavorites).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		await expect(service.listFavorites()).resolves.toMatchObject({ ok: true });
	});

	it("keeps privacy withdrawal authoritative when token refresh fails late", async () => {
		const { service, consent, listFavorites, accessToken, invalidate } =
			scenario();
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		accessToken.mockImplementationOnce(async () => {
			consent.withdraw(() => {});
			throw new ApiError("HTTP_ERROR", 401, "SESSION_EXPIRED");
		});

		await expect(service.listFavorites()).resolves.toMatchObject({
			ok: false,
			kind: "PRIVACY_REQUIRED",
		});
		expect(listFavorites).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("preserves an authentication failure when local credential cleanup throws", async () => {
		const { service, consent, listFavorites, invalidate } = scenario();
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		listFavorites.mockRejectedValueOnce(
			new ApiError("HTTP_ERROR", 401, "SESSION_EXPIRED"),
		);
		invalidate.mockImplementationOnce(() => {
			throw new Error(
				"synthetic removeStorageSync error: private credential details",
			);
		});

		const outcome = await service.listFavorites();
		expect(outcome).toMatchObject({ ok: false, kind: "LOGIN_REQUIRED" });
		expect(invalidate).toHaveBeenCalledOnce();
		if (outcome.ok) throw new Error("authentication failure was accepted");
		expect(outcome.message).toContain("清理尚未完成");
		expect(outcome.message).not.toContain("private credential details");
	});

	it("rejects result mutations before generating an idempotency key", async () => {
		const { service, consent, createUuid } = scenario();
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		await expect(
			service.createFavorite(
				{
					...LIVE_LICENSED_REFERENCE,
					requestId: "bad",
					resultToken: "bad",
				},
				"WANT_TO_GO",
			),
		).resolves.toMatchObject({
			ok: false,
			kind: "INPUT",
		});
		expect(createUuid).not.toHaveBeenCalled();
	});

	it("does not generate an idempotency key before privacy consent", async () => {
		const { service, createUuid, accessToken } = scenario();
		await expect(
			service.createFavorite(LIVE_LICENSED_REFERENCE, "WANT_TO_GO"),
		).resolves.toMatchObject({
			ok: false,
			kind: "PRIVACY_REQUIRED",
		});
		expect(createUuid).not.toHaveBeenCalled();
		expect(accessToken).not.toHaveBeenCalled();
	});

	it("rejects demo or live-display-only results before creating an id", async () => {
		const { service, consent, createUuid } = scenario();
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));

		await expect(
			service.createFavorite(
				{ ...LIVE_LICENSED_REFERENCE, dataMode: "DEMO" },
				"WANT_TO_GO",
			),
		).resolves.toMatchObject({ ok: false, kind: "RIGHTS_UNAVAILABLE" });
		await expect(
			service.createPrivateFeedback(
				{
					...LIVE_LICENSED_REFERENCE,
					dataRightsMode: "LIVE_DISPLAY_ONLY",
				},
				"LIKE",
			),
		).resolves.toMatchObject({ ok: false, kind: "RIGHTS_UNAVAILABLE" });
		expect(createUuid).not.toHaveBeenCalled();
	});

	it("requires saved-resource identifiers for new persistent references", async () => {
		const { service, consent, createUuid, accessToken } = scenario();
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));

		await expect(
			service.createFavorite(LIVE_LICENSED_REFERENCE, "REGULAR"),
		).resolves.toMatchObject({ ok: false, kind: "RIGHTS_UNAVAILABLE" });
		expect(createUuid).not.toHaveBeenCalled();
		expect(accessToken).not.toHaveBeenCalled();
	});

	it("rechecks saved-resource identifiers after asynchronous UUID creation", async () => {
		const storage = new MemoryStorage();
		const consent = new PrivacyConsentAuthority(storage);
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		let capabilities = {
			favoritesEnabled: true,
			historyEnabled: true,
			privateFeedbackEnabled: true,
			savedResourceIdsEnabled: true,
		};
		const createFavorite = vi.fn();
		const accessToken = vi.fn().mockResolvedValue("a".repeat(43));
		const service = new SavedResourcesService(
			{ createFavorite } as unknown as SavedResourcesApi,
			{ accessToken, invalidate: vi.fn() },
			consent,
			() => capabilities,
			vi.fn(async () => {
				capabilities = { ...capabilities, savedResourceIdsEnabled: false };
				return "33333333-3333-4333-8333-333333333333";
			}),
		);

		await expect(
			service.createFavorite(LIVE_LICENSED_REFERENCE, "WANT_TO_GO"),
		).resolves.toMatchObject({ ok: false, kind: "RIGHTS_UNAVAILABLE" });
		expect(accessToken).not.toHaveBeenCalled();
		expect(createFavorite).not.toHaveBeenCalled();
	});

	it("rechecks capabilities after asynchronous access-token acquisition", async () => {
		const storage = new MemoryStorage();
		const consent = new PrivacyConsentAuthority(storage);
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		let capabilities = {
			favoritesEnabled: true,
			historyEnabled: true,
			privateFeedbackEnabled: true,
			savedResourceIdsEnabled: true,
		};
		const listFavorites = vi.fn();
		const service = new SavedResourcesService(
			{ listFavorites } as unknown as SavedResourcesApi,
			{
				accessToken: vi.fn(async () => {
					capabilities = { ...capabilities, favoritesEnabled: false };
					return "a".repeat(43);
				}),
				invalidate: vi.fn(),
			},
			consent,
			() => capabilities,
			vi.fn(),
		);

		await expect(service.listFavorites()).resolves.toMatchObject({
			ok: false,
			kind: "RIGHTS_UNAVAILABLE",
		});
		expect(listFavorites).not.toHaveBeenCalled();
	});
});
