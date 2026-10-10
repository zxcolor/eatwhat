import { describe, expect, it } from "vitest";
import { HttpApi, type HttpRequest } from "../../core/api-client";
import {
	HttpFeatureConfigSource,
	HttpSavedResourcesApi,
	HttpSupportFeedbackApi,
} from "./api-adapters";

const ACCESS_TOKEN = "access-token";
const CURSOR = "a".repeat(43);
const FAVORITE_ID = "11111111-1111-4111-8111-111111111111";
const FEEDBACK_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";

const presentation = Object.freeze({
	presentationStatus: "AVAILABLE",
	name: "演示餐厅",
	address: null,
	sourceLabel: "演示数据",
	dataMode: "DEMO",
	openStatus: "UNKNOWN",
	averageCostYuan: null,
	tags: ["家常菜"],
	resolvedAt: "2026-08-30T00:00:00.000Z",
});

const favorite = Object.freeze({
	favoriteId: FAVORITE_ID,
	group: "WANT_TO_GO",
	createdAt: "2026-08-30T00:00:00.000Z",
	presentation,
});

const privateFeedback = Object.freeze({
	feedbackId: FEEDBACK_ID,
	type: "LIKE",
	visibility: "PRIVATE",
	createdAt: "2026-08-30T00:00:00.000Z",
	presentation,
});

class MockHttpApi extends HttpApi {
	readonly requests: HttpRequest<unknown>[] = [];

	constructor(private response: unknown) {
		super({ request: () => undefined }, "https://api.example.com");
	}

	respondWith(value: unknown): void {
		this.response = value;
	}

	override async request<Value>(input: HttpRequest<Value>): Promise<Value> {
		this.requests.push(input as HttpRequest<unknown>);
		return input.parser(this.response);
	}

	latest(): HttpRequest<unknown> {
		const request = this.requests[this.requests.length - 1];
		if (request === undefined) throw new Error("EXPECTED_HTTP_REQUEST");
		return request;
	}
}

describe("HTTP feature adapters", () => {
	it("loads the raw feature config from the public config endpoint", async () => {
		const rawConfig = { accountsEnabled: true, futureField: "preserved" };
		const http = new MockHttpApi(rawConfig);

		await expect(
			new HttpFeatureConfigSource(http).loadFeatureConfig(),
		).resolves.toBe(rawConfig);
		expect(http.latest()).toMatchObject({
			method: "GET",
			path: "/v1/config",
		});
		expect(http.latest().bearer).toBeUndefined();
	});

	it("maps favorite list, create, update and delete requests", async () => {
		const http = new MockHttpApi({ items: [favorite], nextCursor: null });
		const api = new HttpSavedResourcesApi(http);

		await expect(
			api.listFavorites(ACCESS_TOKEN, CURSOR, "WANT_TO_GO"),
		).resolves.toEqual({
			items: [favorite],
			nextCursor: null,
		});
		expect(http.latest()).toMatchObject({
			method: "GET",
			path: "/v1/favorites",
			query: { limit: 20, cursor: CURSOR, group: "WANT_TO_GO" },
			bearer: ACCESS_TOKEN,
		});

		const createRequest = {
			idempotencyKey: IDEMPOTENCY_KEY,
			result: { requestId: REQUEST_ID, resultToken: CURSOR },
			group: "WANT_TO_GO" as const,
		};
		http.respondWith(favorite);
		await expect(
			api.createFavorite(ACCESS_TOKEN, createRequest),
		).resolves.toEqual(favorite);
		expect(http.latest()).toMatchObject({
			method: "POST",
			path: "/v1/favorites",
			body: createRequest,
			bearer: ACCESS_TOKEN,
		});

		const updateRequest = {
			idempotencyKey: IDEMPOTENCY_KEY,
			group: "REGULAR" as const,
		};
		http.respondWith({ ...favorite, group: "REGULAR" });
		await expect(
			api.updateFavoriteGroup(ACCESS_TOKEN, FAVORITE_ID, updateRequest),
		).resolves.toMatchObject({ group: "REGULAR" });
		expect(http.latest()).toMatchObject({
			method: "POST",
			path: `/v1/favorites/${FAVORITE_ID}/group`,
			body: updateRequest,
			bearer: ACCESS_TOKEN,
		});

		http.respondWith(undefined);
		await expect(
			api.deleteFavorite(ACCESS_TOKEN, FAVORITE_ID),
		).resolves.toBeUndefined();
		expect(http.latest()).toMatchObject({
			method: "DELETE",
			path: `/v1/favorites/${FAVORITE_ID}`,
			bearer: ACCESS_TOKEN,
		});
	});

	it("maps history list and clear requests with strict page parsing", async () => {
		const http = new MockHttpApi({
			items: [],
			nextCursor: null,
			retentionDays: 90,
		});
		const api = new HttpSavedResourcesApi(http);

		await expect(api.listHistory(ACCESS_TOKEN, CURSOR)).resolves.toEqual({
			items: [],
			nextCursor: null,
			retentionDays: 90,
		});
		expect(http.latest()).toMatchObject({
			method: "GET",
			path: "/v1/history",
			query: { limit: 20, cursor: CURSOR },
			bearer: ACCESS_TOKEN,
		});

		http.respondWith({ items: [], nextCursor: null, retentionDays: 30 });
		await expect(api.listHistory(ACCESS_TOKEN)).rejects.toThrow(
			"PERSISTENCE_RESPONSE_INVALID",
		);

		http.respondWith("");
		await expect(api.clearHistory(ACCESS_TOKEN)).resolves.toBeUndefined();
		expect(http.latest()).toMatchObject({
			method: "DELETE",
			path: "/v1/history",
			bearer: ACCESS_TOKEN,
		});
	});

	it("maps private-feedback list, create, item delete and clear requests", async () => {
		const http = new MockHttpApi({
			items: [privateFeedback],
			nextCursor: null,
		});
		const api = new HttpSavedResourcesApi(http);

		await expect(
			api.listPrivateFeedback(ACCESS_TOKEN, CURSOR),
		).resolves.toEqual({
			items: [privateFeedback],
			nextCursor: null,
		});
		expect(http.latest()).toMatchObject({
			method: "GET",
			path: "/v1/private-feedback",
			query: { limit: 20, cursor: CURSOR },
			bearer: ACCESS_TOKEN,
		});

		const createRequest = {
			idempotencyKey: IDEMPOTENCY_KEY,
			result: { requestId: REQUEST_ID, resultToken: CURSOR },
			type: "LIKE" as const,
		};
		http.respondWith(privateFeedback);
		await expect(
			api.createPrivateFeedback(ACCESS_TOKEN, createRequest),
		).resolves.toEqual(privateFeedback);
		expect(http.latest()).toMatchObject({
			method: "POST",
			path: "/v1/private-feedback",
			body: createRequest,
			bearer: ACCESS_TOKEN,
		});

		http.respondWith(null);
		await api.deletePrivateFeedback(ACCESS_TOKEN, FEEDBACK_ID);
		expect(http.latest()).toMatchObject({
			method: "DELETE",
			path: `/v1/private-feedback/${FEEDBACK_ID}`,
			bearer: ACCESS_TOKEN,
		});

		await api.clearPrivateFeedback(ACCESS_TOKEN);
		expect(http.latest()).toMatchObject({
			method: "DELETE",
			path: "/v1/private-feedback",
			bearer: ACCESS_TOKEN,
		});
	});

	it("submits support feedback with an optional bearer and strict response parser", async () => {
		const response = {
			feedbackId: FEEDBACK_ID,
			accepted: true,
			retentionAfterClosureDays: 180,
		};
		const request = {
			submissionId: REQUEST_ID,
			category: "PRODUCT" as const,
			message: "这是足够长的产品反馈正文。",
		};
		const http = new MockHttpApi(response);
		const api = new HttpSupportFeedbackApi(http);

		await expect(
			api.submitSupportFeedback(request, ACCESS_TOKEN),
		).resolves.toEqual(response);
		expect(http.latest()).toMatchObject({
			method: "POST",
			path: "/v1/support-feedback",
			body: request,
			bearer: ACCESS_TOKEN,
		});

		await api.submitSupportFeedback(request, null);
		expect(http.latest().bearer).toBeNull();

		http.respondWith({ ...response, leakedField: true });
		await expect(api.submitSupportFeedback(request, null)).rejects.toThrow(
			"SUPPORT_FEEDBACK_RESPONSE_INVALID",
		);
	});

	it("rejects non-empty bodies for 204 delete contracts", async () => {
		const http = new MockHttpApi({ unexpected: true });

		await expect(
			new HttpSavedResourcesApi(http).clearPrivateFeedback(ACCESS_TOKEN),
		).rejects.toThrow("NO_CONTENT_RESPONSE_INVALID");
	});
});
