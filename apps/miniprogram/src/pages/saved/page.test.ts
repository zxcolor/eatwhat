import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistenceCapabilities } from "../../features/config/feature-config";
import type {
	FavoriteRecord,
	FavoritesPage,
} from "../../features/persistence/contracts";
import type { SavedResourcesOutcome } from "../../features/persistence/saved-resources";

const CAPABILITIES: PersistenceCapabilities = {
	favoritesEnabled: true,
	historyEnabled: true,
	privateFeedbackEnabled: true,
	savedResourceIdsEnabled: true,
};

const FAVORITE: FavoriteRecord = {
	favoriteId: "11111111-1111-4111-8111-111111111111",
	group: "WANT_TO_GO",
	createdAt: "2026-09-17T00:00:00.000Z",
	presentation: {
		presentationStatus: "AVAILABLE",
		name: "合成测试餐厅",
		address: null,
		sourceLabel: "合成测试",
		dataMode: "LIVE",
		openStatus: "UNKNOWN",
		averageCostYuan: null,
		tags: [],
		resolvedAt: "2026-09-17T00:00:00.000Z",
	},
};

function favorites(
	items: readonly FavoriteRecord[] = [FAVORITE],
): SavedResourcesOutcome<FavoritesPage> {
	return { ok: true, value: { items, nextCursor: null } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

interface SavedPage {
	data: {
		busy: boolean;
		sections: readonly Record<string, unknown>[];
		favorites: readonly Record<string, unknown>[];
		history: readonly Record<string, unknown>[];
		feedback: readonly Record<string, unknown>[];
		favoriteRecords: readonly FavoriteRecord[];
		feedbackRecords: readonly Record<string, unknown>[];
		hasMore: boolean;
		message: string;
	};
	setData(patch: object): void;
	onLoad(): void | Promise<void>;
	onShow(): void | Promise<void>;
	onHide(): void;
	onUnload(): void;
	load(append: boolean): Promise<void>;
	mutate(
		operation: () => Promise<{ ok: boolean }>,
		successMessage: string,
	): Promise<void>;
}

async function setup() {
	vi.resetModules();
	let options: Record<string, unknown> = {};
	let capabilities: PersistenceCapabilities | null = CAPABILITIES;
	const saved = {
		listFavorites: vi
			.fn<() => Promise<SavedResourcesOutcome<FavoritesPage>>>()
			.mockResolvedValue(favorites()),
	};
	const initializeAfterConsent = vi.fn(async () => ({ kind: "READY" }));
	const runtime = { hideShareMenu: vi.fn(), reLaunch: vi.fn() };
	vi.stubGlobal("wx", runtime);
	vi.stubGlobal("Page", (value: Record<string, unknown>) => {
		options = value;
	});
	vi.stubGlobal("getApp", () => ({
		globalData: {
			preferences: { theme: () => "LIGHT" },
			consent: { isAllowed: () => true },
			initializeAfterConsent,
			featureConfig: {
				current: () =>
					capabilities === null
						? { kind: "UNCONFIRMED" }
						: {
								kind: "READY",
								config: { persistenceCapabilities: capabilities },
							},
			},
			saved,
		},
	}));
	await import("./index");
	const page = {
		...options,
		data: { ...(options.data as object) },
		setData(patch: object) {
			Object.assign(this.data, patch);
		},
	} as unknown as SavedPage;
	await page.onLoad();
	return {
		page,
		saved,
		initializeAfterConsent,
		runtime,
		setCapabilities(value: PersistenceCapabilities | null) {
			capabilities = value;
		},
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("saved account records lifecycle", () => {
	it("waits for foreground configuration before reloading account records", async () => {
		const { page, saved, initializeAfterConsent, setCapabilities } =
			await setup();
		await page.onShow();
		expect(page.data.favoriteRecords).toEqual([FAVORITE]);
		page.onHide();
		setCapabilities(null);
		const configuration = deferred<{ kind: string }>();
		initializeAfterConsent.mockReturnValueOnce(configuration.promise);
		const previousCalls = saved.listFavorites.mock.calls.length;
		const showing = page.onShow();
		expect(page.data.favoriteRecords).toEqual([]);
		expect(page.data.sections).toEqual([]);
		expect(saved.listFavorites).toHaveBeenCalledTimes(previousCalls);

		setCapabilities(CAPABILITIES);
		configuration.resolve({ kind: "READY" });
		await showing;
		expect(saved.listFavorites).toHaveBeenCalledTimes(previousCalls + 1);
		expect(page.data.favoriteRecords).toEqual([FAVORITE]);
		expect(page.data.busy).toBe(false);
	});

	it("removes every displayed record when persistence permission is revoked", async () => {
		const { page, saved, setCapabilities } = await setup();
		await page.onShow();
		page.setData({
			history: [{ name: "合成历史" }],
			feedback: [{ name: "合成私有反馈" }],
			feedbackRecords: [{ feedbackId: "synthetic" }],
			hasMore: true,
		});
		page.onHide();
		setCapabilities({
			favoritesEnabled: false,
			historyEnabled: false,
			privateFeedbackEnabled: false,
			savedResourceIdsEnabled: false,
		});
		const previousCalls = saved.listFavorites.mock.calls.length;
		await page.onShow();
		expect(saved.listFavorites).toHaveBeenCalledTimes(previousCalls);
		for (const key of [
			"sections",
			"favorites",
			"history",
			"feedback",
			"favoriteRecords",
			"feedbackRecords",
		] as const) {
			expect(page.data[key]).toEqual([]);
		}
		expect(page.data.hasMore).toBe(false);
		expect(page.data.message).toContain("尚未开放");
	});

	it("discards an old request after hiding instead of replacing a newer account view", async () => {
		const { page, saved } = await setup();
		await page.onShow();
		const oldRequest = deferred<SavedResourcesOutcome<FavoritesPage>>();
		saved.listFavorites.mockReturnValueOnce(oldRequest.promise);
		const loading = page.load(false);
		page.onHide();
		const current = {
			...FAVORITE,
			favoriteId: "22222222-2222-4222-8222-222222222222",
		};
		saved.listFavorites.mockResolvedValueOnce(favorites([current]));
		await page.onShow();
		oldRequest.resolve(favorites());
		await loading;
		expect(page.data.favoriteRecords).toEqual([current]);
		expect(page.data.busy).toBe(false);
	});

	it("does not load or navigate from configuration completed after the page unloads", async () => {
		const { page, saved, initializeAfterConsent, runtime } = await setup();
		const configuration = deferred<{ kind: string; minimumVersion: string }>();
		initializeAfterConsent.mockReturnValueOnce(configuration.promise);
		const showing = page.onShow();
		page.onUnload();
		configuration.resolve({
			kind: "UPDATE_REQUIRED",
			minimumVersion: "99.0.0",
		});
		await showing;
		expect(saved.listFavorites).not.toHaveBeenCalled();
		expect(runtime.reLaunch).not.toHaveBeenCalled();
		expect(page.data.favoriteRecords).toEqual([]);
		expect(page.data.busy).toBe(false);
	});

	it("recovers from initialization rejection without exposing its exception", async () => {
		const { page, saved, initializeAfterConsent } = await setup();
		initializeAfterConsent.mockRejectedValueOnce(
			new Error("synthetic private initialization error"),
		);
		await expect(page.onShow()).resolves.toBeUndefined();
		expect(page.data.busy).toBe(false);
		expect(page.data.favoriteRecords).toEqual([]);
		expect(page.data.message).toContain("重试");
		expect(page.data.message).not.toContain("private initialization error");
		expect(saved.listFavorites).not.toHaveBeenCalled();

		await page.onShow();
		expect(page.data.favoriteRecords).toEqual([FAVORITE]);
		expect(page.data.message).toBe("");
	});

	it("clears stale records and releases loading when a list operation rejects", async () => {
		const { page, saved } = await setup();
		await page.onShow();
		saved.listFavorites.mockRejectedValueOnce(
			new Error("synthetic private list error"),
		);
		await expect(page.load(false)).resolves.toBeUndefined();
		expect(page.data.busy).toBe(false);
		expect(page.data.favoriteRecords).toEqual([]);
		expect(page.data.favorites).toEqual([]);
		expect(page.data.message).toContain("重试");
		expect(page.data.message).not.toContain("private list error");

		await page.load(false);
		expect(page.data.favoriteRecords).toEqual([FAVORITE]);
	});

	it("does not claim a mutation succeeded when it rejects and permits a retry", async () => {
		const { page } = await setup();
		await page.onShow();
		await expect(
			page.mutate(async () => {
				throw new Error("synthetic private storage error");
			}, "操作成功"),
		).resolves.toBeUndefined();
		expect(page.data.busy).toBe(false);
		expect(page.data.favoriteRecords).toEqual([]);
		expect(page.data.message).toContain("重试");
		expect(page.data.message).not.toContain("操作成功");
		expect(page.data.message).not.toContain("private storage error");

		await page.mutate(async () => ({ ok: true }), "操作成功");
		expect(page.data.message).toBe("操作成功");
		expect(page.data.busy).toBe(false);
	});

	it("keeps a newer request busy when an obsolete request rejects", async () => {
		const { page, saved } = await setup();
		await page.onShow();
		const oldRequest = deferred<SavedResourcesOutcome<FavoritesPage>>();
		saved.listFavorites.mockReturnValueOnce(oldRequest.promise);
		const loading = page.load(false);
		page.onHide();
		const currentRequest = deferred<SavedResourcesOutcome<FavoritesPage>>();
		saved.listFavorites.mockReturnValueOnce(currentRequest.promise);
		const showing = page.onShow();
		await vi.waitFor(() =>
			expect(saved.listFavorites).toHaveBeenCalledTimes(3),
		);
		oldRequest.reject(new Error("obsolete synthetic error"));
		await loading;
		expect(page.data.busy).toBe(true);
		expect(page.data.message).toBe("");

		currentRequest.resolve(favorites());
		await showing;
		expect(page.data.busy).toBe(false);
		expect(page.data.favoriteRecords).toEqual([FAVORITE]);
	});
});
