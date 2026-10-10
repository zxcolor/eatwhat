import type { PersistenceCapabilities } from "../config/feature-config";
import type { PrivacyConsentAuthority } from "../consent/consent-authority";
import {
	type FavoriteGroup,
	type FavoriteRecord,
	type FavoritesPage,
	isContractUuid,
	isResultToken,
	type PrivateFeedbackPage,
	type PrivateFeedbackRecord,
	type PrivateFeedbackType,
	type RecommendationHistoryPage,
} from "./contracts";

export interface SavedResourcesApi {
	listFavorites(
		accessToken: string,
		cursor?: string,
		group?: FavoriteGroup,
	): Promise<FavoritesPage>;
	createFavorite(
		accessToken: string,
		request: {
			readonly idempotencyKey: string;
			readonly result: {
				readonly requestId: string;
				readonly resultToken: string;
			};
			readonly group: FavoriteGroup;
		},
	): Promise<FavoriteRecord>;
	updateFavoriteGroup(
		accessToken: string,
		favoriteId: string,
		request: { readonly idempotencyKey: string; readonly group: FavoriteGroup },
	): Promise<FavoriteRecord>;
	deleteFavorite(accessToken: string, favoriteId: string): Promise<void>;
	listHistory(
		accessToken: string,
		cursor?: string,
	): Promise<RecommendationHistoryPage>;
	clearHistory(accessToken: string): Promise<void>;
	listPrivateFeedback(
		accessToken: string,
		cursor?: string,
	): Promise<PrivateFeedbackPage>;
	createPrivateFeedback(
		accessToken: string,
		request: {
			readonly idempotencyKey: string;
			readonly result: {
				readonly requestId: string;
				readonly resultToken: string;
			};
			readonly type: PrivateFeedbackType;
		},
	): Promise<PrivateFeedbackRecord>;
	deletePrivateFeedback(accessToken: string, feedbackId: string): Promise<void>;
	clearPrivateFeedback(accessToken: string): Promise<void>;
}

export interface SavedResourcesAuthorization {
	accessToken(): Promise<string | null>;
	invalidate(): void;
}

export interface PersistableRecommendationReference {
	readonly requestId: string;
	readonly resultToken: string;
	readonly dataMode: "LIVE" | "DEMO";
	readonly dataRightsMode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
}

export type SavedResourcesFailureKind =
	| "INPUT"
	| "PRIVACY_REQUIRED"
	| "LOGIN_REQUIRED"
	| "RIGHTS_UNAVAILABLE"
	| "RESULT_EXPIRED"
	| "CONFLICT"
	| "RATE_LIMITED"
	| "NETWORK"
	| "UNAVAILABLE"
	| "INVALID_RESPONSE"
	| "INCOMPATIBLE_API"
	| "UNKNOWN";

export type SavedResourcesOutcome<Value> =
	| Readonly<{ ok: true; value: Value }>
	| Readonly<{ ok: false; kind: SavedResourcesFailureKind; message: string }>;

interface ErrorShape {
	readonly kind?: unknown;
	readonly status?: unknown;
}

export class SavedResourcesService {
	constructor(
		private readonly api: SavedResourcesApi,
		private readonly auth: SavedResourcesAuthorization,
		private readonly consent: PrivacyConsentAuthority,
		private readonly capabilities: () => PersistenceCapabilities | null,
		private readonly createUuid: () => Promise<string>,
	) {}

	listFavorites(
		cursor?: string,
	): Promise<SavedResourcesOutcome<FavoritesPage>> {
		if (!validCursor(cursor))
			return Promise.resolve(input("收藏分页凭据无效，请重新加载"));
		return this.authorized("favoritesEnabled", (token) =>
			this.api.listFavorites(token, cursor),
		);
	}

	async createFavorite(
		reference: PersistableRecommendationReference,
		group: FavoriteGroup,
	): Promise<SavedResourcesOutcome<FavoriteRecord>> {
		const invalid = validateCreationReference(reference);
		if (invalid !== null) return invalid;
		const denied = this.checkAuthority("favoritesEnabled", true);
		if (denied !== null) return denied;
		const idempotencyKey = await this.safeUuid();
		if (idempotencyKey === null) return input("暂时无法创建安全操作凭据");
		return this.authorized(
			"favoritesEnabled",
			(token) =>
				this.api.createFavorite(token, {
					idempotencyKey,
					result: {
						requestId: reference.requestId,
						resultToken: reference.resultToken,
					},
					group,
				}),
			true,
		);
	}

	async updateFavoriteGroup(
		favoriteId: string,
		group: FavoriteGroup,
	): Promise<SavedResourcesOutcome<FavoriteRecord>> {
		if (!isContractUuid(favoriteId)) return input("收藏记录无效，请重新加载");
		const denied = this.checkAuthority("favoritesEnabled");
		if (denied !== null) return denied;
		const idempotencyKey = await this.safeUuid();
		if (idempotencyKey === null) return input("暂时无法创建安全操作凭据");
		return this.authorized("favoritesEnabled", (token) =>
			this.api.updateFavoriteGroup(token, favoriteId, {
				idempotencyKey,
				group,
			}),
		);
	}

	deleteFavorite(favoriteId: string): Promise<SavedResourcesOutcome<void>> {
		if (!isContractUuid(favoriteId)) {
			return Promise.resolve(input("收藏记录无效，请重新加载"));
		}
		return this.authorized("favoritesEnabled", (token) =>
			this.api.deleteFavorite(token, favoriteId),
		);
	}

	listHistory(
		cursor?: string,
	): Promise<SavedResourcesOutcome<RecommendationHistoryPage>> {
		if (!validCursor(cursor))
			return Promise.resolve(input("历史分页凭据无效，请重新加载"));
		return this.authorized("historyEnabled", (token) =>
			this.api.listHistory(token, cursor),
		);
	}

	clearHistory(): Promise<SavedResourcesOutcome<void>> {
		return this.authorized("historyEnabled", (token) =>
			this.api.clearHistory(token),
		);
	}

	listPrivateFeedback(
		cursor?: string,
	): Promise<SavedResourcesOutcome<PrivateFeedbackPage>> {
		if (!validCursor(cursor))
			return Promise.resolve(input("反馈分页凭据无效，请重新加载"));
		return this.authorized("privateFeedbackEnabled", (token) =>
			this.api.listPrivateFeedback(token, cursor),
		);
	}

	async createPrivateFeedback(
		reference: PersistableRecommendationReference,
		type: PrivateFeedbackType,
	): Promise<SavedResourcesOutcome<PrivateFeedbackRecord>> {
		const invalid = validateCreationReference(reference);
		if (invalid !== null) return invalid;
		const denied = this.checkAuthority("privateFeedbackEnabled", true);
		if (denied !== null) return denied;
		const idempotencyKey = await this.safeUuid();
		if (idempotencyKey === null) return input("暂时无法创建安全操作凭据");
		return this.authorized(
			"privateFeedbackEnabled",
			(token) =>
				this.api.createPrivateFeedback(token, {
					idempotencyKey,
					result: {
						requestId: reference.requestId,
						resultToken: reference.resultToken,
					},
					type,
				}),
			true,
		);
	}

	deletePrivateFeedback(
		feedbackId: string,
	): Promise<SavedResourcesOutcome<void>> {
		if (!isContractUuid(feedbackId)) {
			return Promise.resolve(input("私有反馈记录无效，请重新加载"));
		}
		return this.authorized("privateFeedbackEnabled", (token) =>
			this.api.deletePrivateFeedback(token, feedbackId),
		);
	}

	clearPrivateFeedback(): Promise<SavedResourcesOutcome<void>> {
		return this.authorized("privateFeedbackEnabled", (token) =>
			this.api.clearPrivateFeedback(token),
		);
	}

	private async authorized<Value>(
		capability: keyof Pick<
			PersistenceCapabilities,
			"favoritesEnabled" | "historyEnabled" | "privateFeedbackEnabled"
		>,
		operation: (accessToken: string) => Promise<Value>,
		requireSavedResourceIds = false,
	): Promise<SavedResourcesOutcome<Value>> {
		const denied = this.checkAuthority(capability, requireSavedResourceIds);
		if (denied !== null) return denied;
		try {
			const accessToken = await this.auth.accessToken();
			const deniedAfterAuth = this.checkAuthority(
				capability,
				requireSavedResourceIds,
			);
			if (deniedAfterAuth !== null) return deniedAfterAuth;
			if (accessToken === null) {
				return failure(
					"LOGIN_REQUIRED",
					"请先登录后管理账号记录；核心推荐仍可继续使用",
				);
			}
			const value = await operation(accessToken);
			const deniedAfterOperation = this.checkAuthority(
				capability,
				requireSavedResourceIds,
			);
			return deniedAfterOperation ?? Object.freeze({ ok: true, value });
		} catch (error) {
			const deniedAfterFailure = this.checkAuthority(
				capability,
				requireSavedResourceIds,
			);
			if (deniedAfterFailure !== null) return deniedAfterFailure;
			const outcome = mapFailure(error);
			if (outcome.kind === "LOGIN_REQUIRED") {
				try {
					this.auth.invalidate();
				} catch {
					return failure(
						"LOGIN_REQUIRED",
						"登录状态已失效，本机凭据清理尚未完成，请稍后重试。",
					);
				}
			}
			return outcome;
		}
	}

	private checkAuthority(
		capability: keyof Pick<
			PersistenceCapabilities,
			"favoritesEnabled" | "historyEnabled" | "privateFeedbackEnabled"
		>,
		requireSavedResourceIds = false,
	): Readonly<{
		ok: false;
		kind: SavedResourcesFailureKind;
		message: string;
	}> | null {
		if (!this.consent.isAllowed()) {
			return failure(
				"PRIVACY_REQUIRED",
				"请先阅读并同意隐私说明；本次没有发送网络请求",
			);
		}
		const capabilities = this.capabilities();
		if (
			capabilities?.[capability] !== true ||
			(requireSavedResourceIds && !capabilities.savedResourceIdsEnabled)
		) {
			return failure(
				"RIGHTS_UNAVAILABLE",
				"当前数据授权或功能开关不允许此操作；本次没有新增或改写账号数据",
			);
		}
		return null;
	}

	private async safeUuid(): Promise<string | null> {
		try {
			const value = await this.createUuid();
			return isContractUuid(value) ? value : null;
		} catch {
			return null;
		}
	}
}

function validateCreationReference(
	reference: PersistableRecommendationReference,
): SavedResourcesOutcome<never> | null {
	if (
		!isContractUuid(reference.requestId) ||
		!isResultToken(reference.resultToken)
	) {
		return input("本次餐厅结果凭据无效，请重新获取推荐");
	}
	if (
		reference.dataMode !== "LIVE" ||
		reference.dataRightsMode !== "LICENSED_ENRICHMENT"
	) {
		return failure(
			"RIGHTS_UNAVAILABLE",
			"演示或实时展示结果不允许保存餐厅引用；本次没有上传账号数据",
		);
	}
	return null;
}

function validCursor(value: string | undefined): boolean {
	return value === undefined || isResultToken(value);
}

function input(message: string): SavedResourcesOutcome<never> {
	return failure("INPUT", message);
}

function failure(
	kind: SavedResourcesFailureKind,
	message: string,
): Readonly<{ ok: false; kind: SavedResourcesFailureKind; message: string }> {
	return Object.freeze({ ok: false, kind, message });
}

function mapFailure(error: unknown): Readonly<{
	ok: false;
	kind: SavedResourcesFailureKind;
	message: string;
}> {
	const shape =
		typeof error === "object" && error !== null
			? (error as ErrorShape)
			: ({} as ErrorShape);
	if (shape.kind === "NETWORK") {
		return failure("NETWORK", "网络不可用，请检查连接后重试");
	}
	if (shape.kind === "CONTRACT_INCOMPATIBLE") {
		return failure(
			"INCOMPATIBLE_API",
			"当前小程序与服务版本不兼容，请更新后重试",
		);
	}
	if (shape.kind === "INVALID_RESPONSE") {
		return failure(
			"INVALID_RESPONSE",
			"账号数据未通过安全校验，未展示或缓存餐厅信息",
		);
	}
	switch (shape.status) {
		case 400:
		case 404:
			return input("请求内容或记录无效，请刷新后重试") as Readonly<{
				ok: false;
				kind: SavedResourcesFailureKind;
				message: string;
			}>;
		case 401:
			return failure("LOGIN_REQUIRED", "登录状态已失效，请重新登录");
		case 403:
			return failure("RIGHTS_UNAVAILABLE", "当前账号或数据授权不允许此操作");
		case 409:
			return failure("CONFLICT", "保存状态发生冲突，请刷新后重试");
		case 410:
			return failure("RESULT_EXPIRED", "本次餐厅结果已过期，请重新获取推荐");
		case 413:
		case 415:
			return failure("INCOMPATIBLE_API", "当前小程序与服务版本不兼容");
		case 429:
			return failure("RATE_LIMITED", "操作过于频繁，请稍后再试");
		case 500:
		case 503:
			return failure("UNAVAILABLE", "账号数据服务暂时不可用，请稍后重试");
		default:
			return failure("UNKNOWN", "账号数据操作暂时失败，请稍后重试");
	}
}
