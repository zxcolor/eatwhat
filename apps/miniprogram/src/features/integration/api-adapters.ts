import type { HttpApi } from "../../core/api-client";
import type { FeatureConfigSource } from "../config/feature-config";
import {
	parseFavoriteRecord,
	parseFavoritesPage,
	parseHistoryPage,
	parsePrivateFeedbackPage,
	parsePrivateFeedbackRecord,
} from "../persistence/contracts";
import type { SavedResourcesApi } from "../persistence/saved-resources";
import {
	parseSupportFeedbackResponse,
	type SupportFeedbackApi,
} from "../support/support-feedback";

export class HttpFeatureConfigSource implements FeatureConfigSource {
	constructor(private readonly http: HttpApi) {}

	loadFeatureConfig(): Promise<unknown> {
		return this.http.request({
			method: "GET",
			path: "/v1/config",
			parser: (value) => value,
		});
	}
}

export class HttpSavedResourcesApi implements SavedResourcesApi {
	constructor(private readonly http: HttpApi) {}

	listFavorites(
		accessToken: string,
		cursor?: string,
		group?: Parameters<SavedResourcesApi["listFavorites"]>[2],
	): ReturnType<SavedResourcesApi["listFavorites"]> {
		return this.http.request({
			method: "GET",
			path: "/v1/favorites",
			query: { limit: 20, cursor, group },
			bearer: accessToken,
			parser: parseFavoritesPage,
		});
	}

	createFavorite(
		accessToken: string,
		request: Parameters<SavedResourcesApi["createFavorite"]>[1],
	): ReturnType<SavedResourcesApi["createFavorite"]> {
		return this.http.request({
			method: "POST",
			path: "/v1/favorites",
			body: request,
			bearer: accessToken,
			parser: parseFavoriteRecord,
		});
	}

	updateFavoriteGroup(
		accessToken: string,
		favoriteId: string,
		request: Parameters<SavedResourcesApi["updateFavoriteGroup"]>[2],
	): ReturnType<SavedResourcesApi["updateFavoriteGroup"]> {
		return this.http.request({
			method: "POST",
			path: `/v1/favorites/${favoriteId}/group`,
			body: request,
			bearer: accessToken,
			parser: parseFavoriteRecord,
		});
	}

	async deleteFavorite(accessToken: string, favoriteId: string): Promise<void> {
		await this.http.request({
			method: "DELETE",
			path: `/v1/favorites/${favoriteId}`,
			bearer: accessToken,
			parser: parseNoContent,
		});
	}

	listHistory(
		accessToken: string,
		cursor?: string,
	): ReturnType<SavedResourcesApi["listHistory"]> {
		return this.http.request({
			method: "GET",
			path: "/v1/history",
			query: { limit: 20, cursor },
			bearer: accessToken,
			parser: parseHistoryPage,
		});
	}

	async clearHistory(accessToken: string): Promise<void> {
		await this.http.request({
			method: "DELETE",
			path: "/v1/history",
			bearer: accessToken,
			parser: parseNoContent,
		});
	}

	listPrivateFeedback(
		accessToken: string,
		cursor?: string,
	): ReturnType<SavedResourcesApi["listPrivateFeedback"]> {
		return this.http.request({
			method: "GET",
			path: "/v1/private-feedback",
			query: { limit: 20, cursor },
			bearer: accessToken,
			parser: parsePrivateFeedbackPage,
		});
	}

	createPrivateFeedback(
		accessToken: string,
		request: Parameters<SavedResourcesApi["createPrivateFeedback"]>[1],
	): ReturnType<SavedResourcesApi["createPrivateFeedback"]> {
		return this.http.request({
			method: "POST",
			path: "/v1/private-feedback",
			body: request,
			bearer: accessToken,
			parser: parsePrivateFeedbackRecord,
		});
	}

	async deletePrivateFeedback(
		accessToken: string,
		feedbackId: string,
	): Promise<void> {
		await this.http.request({
			method: "DELETE",
			path: `/v1/private-feedback/${feedbackId}`,
			bearer: accessToken,
			parser: parseNoContent,
		});
	}

	async clearPrivateFeedback(accessToken: string): Promise<void> {
		await this.http.request({
			method: "DELETE",
			path: "/v1/private-feedback",
			bearer: accessToken,
			parser: parseNoContent,
		});
	}
}

export class HttpSupportFeedbackApi implements SupportFeedbackApi {
	constructor(private readonly http: HttpApi) {}

	submitSupportFeedback(
		request: Parameters<SupportFeedbackApi["submitSupportFeedback"]>[0],
		accessToken: string | null,
	): ReturnType<SupportFeedbackApi["submitSupportFeedback"]> {
		return this.http.request({
			method: "POST",
			path: "/v1/support-feedback",
			body: request,
			bearer: accessToken,
			parser: parseSupportFeedbackResponse,
		});
	}
}

function parseNoContent(value: unknown): void {
	if (value !== undefined && value !== null && value !== "") {
		throw new Error("NO_CONTENT_RESPONSE_INVALID");
	}
}
