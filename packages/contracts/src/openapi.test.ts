import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AccountExportIdPathSchema,
	AccountExportRequestSchema,
	AccountExportResponseSchema,
	AccountExportStatusResponseSchema,
	ADMIN_CONTRACT_VERSION_HEADER,
	ADMIN_DEVICE_ID_HEADER,
	AdminAuditEventSchema,
	AdminAuditPageResponseSchema,
	AdminAuthenticationOptionsSchema,
	AdminCredentialEnrollVerifyResponseSchema,
	AdminCredentialsResponseSchema,
	AdminCurrentSessionResponseSchema,
	AdminLoginOptionsResponseSchema,
	AdminLoginVerifyResponseSchema,
	AuthCapabilitiesSchema,
	AuthTokenResponseSchema,
	BindIdentityRequestSchema,
	BindIdentityResponseSchema,
	BindingIdPathSchema,
	CONTRACT_VERSION_HEADER,
	CreatePrivateFeedbackRequestSchema,
	CURRENT_ADMIN_CONTRACT_VERSION,
	CURRENT_CONTRACT_VERSION,
	DeleteAccountRequestSchema,
	DeleteAccountResponseSchema,
	EmailCodeChallengeResponseSchema,
	EmailRequestCodeSchema,
	FavoriteIdPathSchema,
	FavoriteMutationRequestSchema,
	FavoriteRecordSchema,
	FavoritesPageSchema,
	FeatureConfigSchema,
	FeedbackIdPathSchema,
	IdentityBindingsResponseSchema,
	LatestAccountExportResponseSchema,
	ListFavoritesQuerySchema,
	ListPrivateFeedbackQuerySchema,
	ListRecommendationHistoryQuerySchema,
	LocationSearchRequestSchema,
	LocationSearchResponseSchema,
	LoginRequestSchema,
	LogoutRequestSchema,
	LogoutResponseSchema,
	OAuthStateRequestSchema,
	OAuthStateResponseSchema,
	PersistedPlacePresentationSchema,
	PersistenceCapabilitiesSchema,
	PhoneCodeChallengeResponseSchema,
	PhoneRequestCodeSchema,
	PlaceSearchRequestSchema,
	PlaceSearchResponseSchema,
	PrivateFeedbackPageSchema,
	PrivateFeedbackRecordSchema,
	RecommendationContextSchema,
	RecommendationEventSchema,
	RecommendationHistoryItemSchema,
	RecommendationHistoryPageSchema,
	RecommendationResponseSchema,
	RecommendationResultReferenceInputSchema,
	RecommendationResultSchema,
	RefreshRequestSchema,
	RevokeSessionResponseSchema,
	ServiceCapabilitiesSchema,
	SessionIdPathSchema,
	SessionsResponseSchema,
	SupportFeedbackCategorySchema,
	SupportFeedbackResponseSchema,
	UnbindIdentityResponseSchema,
	UpdateFavoriteGroupRequestSchema,
} from "./index.js";

type JsonObject = Record<string, unknown>;

const openApiPath = fileURLToPath(
	new URL("../../../docs/openapi.v1.json", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const parsedJson: unknown = JSON.parse(readFileSync(openApiPath, "utf8"));
const OpenApiDocumentShape = z.object({
	openapi: z.literal("3.1.0"),
	jsonSchemaDialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
	info: z.object({
		title: z.string().min(1),
		version: z.literal("1.0.0"),
	}),
	paths: z.record(z.string(), z.unknown()),
	components: z.object({
		schemas: z.record(z.string(), z.unknown()),
		headers: z.record(z.string(), z.unknown()),
		parameters: z.record(z.string(), z.unknown()),
		responses: z.record(z.string(), z.unknown()),
		securitySchemes: z.record(z.string(), z.unknown()),
	}),
});
const openApi = OpenApiDocumentShape.parse(parsedJson);

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(container: JsonObject, key: string): JsonObject {
	const value = container[key];
	if (!isObject(value)) throw new Error(`Expected ${key} to be an object`);
	return value;
}

type HttpMethod = "get" | "post" | "delete";

function pathOperation(path: string, method: HttpMethod): JsonObject {
	const pathItem = openApi.paths[path];
	if (!isObject(pathItem)) throw new Error(`Missing OpenAPI path ${path}`);
	return objectValue(pathItem, method);
}

function apiSource(relativePath: string): string {
	return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function implementedControllerOperations(): {
	path: string;
	method: HttpMethod;
	successStatus: string;
}[] {
	const statusCodes: Readonly<Record<string, string>> = {
		ACCEPTED: "202",
		CREATED: "201",
		NO_CONTENT: "204",
		OK: "200",
	};
	return globSync("apps/api/src/**/*.controller.ts", {
		cwd: repositoryRoot,
	}).flatMap((controllerFile) => {
		const source = apiSource(controllerFile);
		const controller = source.match(/@Controller\("([^"]+)"\)/)?.[1];
		if (controller === undefined) {
			throw new Error(`Cannot extract controller path from ${controllerFile}`);
		}
		if (
			controller !== "health" &&
			!controller.startsWith("v1/") &&
			!controller.startsWith("admin/v1")
		) {
			return [];
		}

		const operations: {
			path: string;
			method: HttpMethod;
			successStatus: string;
		}[] = [];
		const routePattern =
			/@(Get|Post|Delete)\(\s*(?:"([^"]*)")?\s*\)([\s\S]*?)(?=@(?:Get|Post|Delete)\(|$)/g;
		for (const match of source.matchAll(routePattern)) {
			const method = match[1]?.toLowerCase();
			if (method !== "get" && method !== "post" && method !== "delete") {
				throw new Error(`Unsupported route method in ${controllerFile}`);
			}
			const suffix = match[2] ?? "";
			const nestPath = [controller, suffix]
				.filter((part) => part.length > 0)
				.join("/")
				.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
			const explicitStatus = match[3]?.match(
				/@HttpCode\(HttpStatus\.([A-Z_]+)\)/,
			)?.[1];
			const successStatus =
				explicitStatus === undefined
					? method === "post"
						? "201"
						: "200"
					: statusCodes[explicitStatus];
			if (successStatus === undefined) {
				throw new Error(
					`Unknown HttpStatus.${explicitStatus} in ${controllerFile}`,
				);
			}
			operations.push({
				path: `/${nestPath}`,
				method,
				successStatus,
			});
		}
		if (operations.length === 0) {
			throw new Error(`Cannot extract public route from ${controllerFile}`);
		}
		return operations;
	});
}

function resolveLocalReference(reference: string): unknown {
	if (!reference.startsWith("#/")) {
		throw new Error(`Only local OpenAPI references are allowed: ${reference}`);
	}
	let current: unknown = openApi;
	for (const encodedPart of reference.slice(2).split("/")) {
		const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isObject(current) || !(part in current)) {
			throw new Error(`Unresolved OpenAPI reference: ${reference}`);
		}
		current = current[part];
	}
	return current;
}

function collectReferences(
	value: unknown,
	found = new Set<string>(),
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectReferences(item, found);
		return found;
	}
	if (!isObject(value)) return found;
	if (typeof value.$ref === "string") found.add(value.$ref);
	for (const child of Object.values(value)) collectReferences(child, found);
	return found;
}

function collectReferenceLocations(
	value: unknown,
	reference: string,
	path: readonly string[] = [],
	found: string[] = [],
): string[] {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			collectReferenceLocations(
				item,
				reference,
				[...path, String(index)],
				found,
			);
		});
		return found;
	}
	if (!isObject(value)) return found;
	if (value.$ref === reference) found.push([...path, "$ref"].join("."));
	for (const [key, child] of Object.entries(value)) {
		if (key !== "$ref")
			collectReferenceLocations(child, reference, [...path, key], found);
	}
	return found;
}

function dereference(value: unknown, active = new Set<string>()): unknown {
	if (Array.isArray(value))
		return value.map((item) => dereference(item, active));
	if (!isObject(value)) return value;

	if (typeof value.$ref === "string") {
		if (active.has(value.$ref))
			throw new Error(`Cyclic OpenAPI reference: ${value.$ref}`);
		const nextActive = new Set(active).add(value.$ref);
		const resolved = dereference(resolveLocalReference(value.$ref), nextActive);
		const siblings = Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "$ref")
				.map(([key, child]) => [key, dereference(child, active)]),
		);
		if (isObject(resolved)) return { ...resolved, ...siblings };
		if (Object.keys(siblings).length > 0) {
			throw new Error(
				`Reference siblings require an object target: ${value.$ref}`,
			);
		}
		return resolved;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			dereference(child, active),
		]),
	);
}

const contractAnnotationKeys = new Set([
	"$schema",
	"allOf",
	"description",
	"readOnly",
	"writeOnly",
	"x-sensitive",
]);

function contractProjection(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(contractProjection);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !contractAnnotationKeys.has(key))
			.map(([key, child]) => [key, contractProjection(child)]),
	);
}

function zodJsonSchema(schema: z.ZodType, io: "input" | "output"): unknown {
	return contractProjection(
		z.toJSONSchema(schema, {
			io,
			target: "draft-2020-12",
			unrepresentable: "any",
		}),
	);
}

function documentedSchema(name: string): JsonObject {
	const schema = openApi.components.schemas[name];
	if (!isObject(schema)) throw new Error(`Missing OpenAPI schema ${name}`);
	return schema;
}

describe("OpenAPI v1", () => {
	it("is parseable OpenAPI 3.1 with resolvable local references", () => {
		expect(openApi.openapi).toBe("3.1.0");
		expect(openApi.info.version).toBe("1.0.0");
		const references = collectReferences(parsedJson);
		expect(references.size).toBeGreaterThan(0);
		for (const reference of references) {
			expect(() => resolveLocalReference(reference), reference).not.toThrow();
		}
	});

	it("freezes public and administrator paths, methods, status codes and implemented-route drift", () => {
		const expected = [
			{ path: "/health", method: "get", statuses: ["200", "500"] },
			{
				path: "/health/ready",
				method: "get",
				statuses: ["200", "500", "503"],
			},
			{
				path: "/admin/v1/auth/login/options",
				method: "post",
				statuses: ["200", "400", "413", "415", "429", "500", "503"],
			},
			{
				path: "/admin/v1/auth/login/verify",
				method: "post",
				statuses: [
					"200",
					"400",
					"401",
					"413",
					"415",
					"423",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/admin/v1/session",
				method: "get",
				statuses: ["200", "401", "429", "500", "503"],
			},
			{
				path: "/admin/v1/session/logout",
				method: "post",
				statuses: ["204", "400", "401", "413", "415", "429", "500", "503"],
			},
			{
				path: "/admin/v1/credentials",
				method: "get",
				statuses: ["200", "401", "403", "429", "500", "503"],
			},
			{
				path: "/admin/v1/credentials/enroll/options",
				method: "post",
				statuses: [
					"200",
					"400",
					"401",
					"403",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/admin/v1/credentials/enroll/verify",
				method: "post",
				statuses: [
					"201",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/admin/v1/credentials/{credentialHandle}",
				method: "delete",
				statuses: [
					"204",
					"400",
					"401",
					"403",
					"404",
					"409",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/admin/v1/audit",
				method: "get",
				statuses: ["200", "400", "401", "403", "429", "500", "503"],
			},
			{ path: "/v1/config", method: "get", statuses: ["200", "500"] },
			{
				path: "/v1/location-search",
				method: "post",
				statuses: ["200", "400", "413", "415", "429", "500", "503"],
			},
			{
				path: "/v1/place-search",
				method: "post",
				statuses: ["200", "400", "413", "415", "429", "500", "503"],
			},
			{
				path: "/v1/recommendation-events",
				method: "post",
				statuses: [
					"202",
					"400",
					"401",
					"403",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/support-feedback",
				method: "post",
				statuses: [
					"202",
					"400",
					"401",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/recommendations",
				method: "post",
				statuses: ["200", "400", "413", "415", "429", "500", "503"],
			},
			{
				path: "/v1/favorites",
				method: "get",
				statuses: ["200", "400", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/favorites",
				method: "post",
				statuses: [
					"201",
					"400",
					"401",
					"403",
					"409",
					"410",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/favorites/{favoriteId}/group",
				method: "post",
				statuses: [
					"200",
					"400",
					"401",
					"403",
					"404",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/favorites/{favoriteId}",
				method: "delete",
				statuses: ["204", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/history",
				method: "get",
				statuses: ["200", "400", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/history",
				method: "delete",
				statuses: ["204", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/private-feedback",
				method: "get",
				statuses: ["200", "400", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/private-feedback",
				method: "post",
				statuses: [
					"201",
					"400",
					"401",
					"403",
					"409",
					"410",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/private-feedback",
				method: "delete",
				statuses: ["204", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/private-feedback/{feedbackId}",
				method: "delete",
				statuses: ["204", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/auth/phone/request-code",
				method: "post",
				statuses: [
					"202",
					"400",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/auth/email/request-code",
				method: "post",
				statuses: [
					"202",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/auth/oauth/state",
				method: "post",
				statuses: [
					"201",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/auth/login",
				method: "post",
				statuses: [
					"200",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/auth/refresh",
				method: "post",
				statuses: [
					"200",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/auth/logout",
				method: "post",
				statuses: [
					"200",
					"400",
					"401",
					"403",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/auth/identities",
				method: "get",
				statuses: ["200", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/auth/identities",
				method: "post",
				statuses: [
					"201",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/auth/identities/{bindingId}",
				method: "delete",
				statuses: ["200", "400", "401", "403", "409", "429", "500", "503"],
			},
			{
				path: "/v1/auth/sessions",
				method: "get",
				statuses: ["200", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/auth/sessions/{sessionId}",
				method: "delete",
				statuses: ["200", "400", "401", "403", "409", "429", "500", "503"],
			},
			{
				path: "/v1/account/export",
				method: "post",
				statuses: [
					"202",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/account/exports/latest",
				method: "get",
				statuses: ["200", "401", "403", "429", "500", "503"],
			},
			{
				path: "/v1/account/exports/{exportId}",
				method: "get",
				statuses: ["200", "400", "401", "403", "404", "429", "500", "503"],
			},
			{
				path: "/v1/account/exports/{exportId}/content",
				method: "get",
				statuses: [
					"200",
					"400",
					"401",
					"403",
					"404",
					"409",
					"410",
					"429",
					"500",
					"503",
				],
			},
			{
				path: "/v1/account",
				method: "delete",
				statuses: [
					"202",
					"400",
					"401",
					"403",
					"409",
					"413",
					"415",
					"429",
					"500",
					"503",
				],
			},
		] as const satisfies readonly {
			path: string;
			method: HttpMethod;
			statuses: readonly string[];
		}[];

		const expectedPaths = [...new Set(expected.map(({ path }) => path))].sort();
		expect(Object.keys(openApi.paths).sort()).toEqual(expectedPaths);
		for (const contract of expected) {
			const operation = pathOperation(contract.path, contract.method);
			expect(Object.keys(objectValue(operation, "responses")).sort()).toEqual(
				[...contract.statuses].sort(),
			);
		}

		// Controllers may land after a contract is frozen, but an implemented public
		// route can never be missing or disagree on its successful status.
		for (const operation of implementedControllerOperations()) {
			const expectedOperation = expected.find(
				(contract) =>
					contract.path === operation.path &&
					contract.method === operation.method,
			);
			expect(
				expectedOperation,
				`${operation.method} ${operation.path}`,
			).toBeDefined();
			expect(
				objectValue(
					pathOperation(operation.path, operation.method),
					"responses",
				),
			).toHaveProperty(operation.successStatus);
		}

		expect(apiSource("apps/api/src/common/http-problem-details.ts")).toMatch(
			/INVALID_JSON[\s\S]*PAYLOAD_TOO_LARGE[\s\S]*UNSUPPORTED_MEDIA_TYPE/,
		);
		expect(apiSource("apps/api/src/common/http-runtime-security.ts")).toContain(
			'code: "UNSUPPORTED_MEDIA_TYPE"',
		);
		expect(apiSource("apps/api/src/common/ip-rate-limit.guard.ts")).toContain(
			"HttpStatus.TOO_MANY_REQUESTS",
		);
		expect(
			apiSource("apps/api/src/recommendations/recommendations.service.ts"),
		).toContain("ServiceUnavailableException");
	});

	it("documents the server-owned contract version on every response", () => {
		const contractHeader = objectValue(
			openApi.components.headers,
			"ContractVersion",
		);
		expect(contractHeader.required).toBe(true);
		expect(objectValue(contractHeader, "schema")).toEqual({
			type: "string",
			const: CURRENT_CONTRACT_VERSION,
		});

		for (const [path, pathItem] of Object.entries(openApi.paths)) {
			if (!isObject(pathItem)) throw new Error(`Invalid path item ${path}`);
			for (const method of ["get", "post", "delete"] as const) {
				if (!(method in pathItem)) continue;
				const operation = pathOperation(path, method);
				const parameters = operation.parameters;
				expect(JSON.stringify(parameters)).toContain(
					"#/components/parameters/ClientContractVersion",
				);

				for (const [status, responseOrReference] of Object.entries(
					objectValue(operation, "responses"),
				)) {
					const response = dereference(responseOrReference);
					if (!isObject(response)) {
						throw new Error(
							`Invalid response object for ${method} ${path} ${status}`,
						);
					}
					const headers = objectValue(response, "headers");
					const documentedHeader = dereference(
						headers[CONTRACT_VERSION_HEADER],
					);
					expect(
						documentedHeader,
						`${method.toUpperCase()} ${path} ${status}`,
					).toMatchObject({
						required: true,
						schema: { type: "string", const: CURRENT_CONTRACT_VERSION },
					});
				}
			}
		}
	});

	it("isolates the administrator contract, bearer and discoverable passkey flow", () => {
		const adminContractHeader = objectValue(
			openApi.components.headers,
			"AdminContractVersion",
		);
		expect(adminContractHeader.required).toBe(true);
		expect(objectValue(adminContractHeader, "schema")).toEqual({
			type: "string",
			const: CURRENT_ADMIN_CONTRACT_VERSION,
		});
		expect(
			objectValue(openApi.components.securitySchemes, "AdminBearerAuth"),
		).toMatchObject({
			type: "http",
			scheme: "bearer",
			bearerFormat: "32-byte opaque admin session",
		});
		expect(
			objectValue(openApi.components.parameters, "AdminDeviceId").name,
		).toBe(ADMIN_DEVICE_ID_HEADER);

		const unauthenticated = new Set([
			"post /admin/v1/auth/login/options",
			"post /admin/v1/auth/login/verify",
		]);
		for (const [path, pathItem] of Object.entries(openApi.paths)) {
			if (!path.startsWith("/admin/v1/")) continue;
			if (!isObject(pathItem)) throw new Error(`Invalid path item ${path}`);
			for (const method of ["get", "post", "delete"] as const) {
				if (!(method in pathItem)) continue;
				const operation = pathOperation(path, method);
				const key = `${method} ${path}`;
				expect(operation.security, key).toEqual(
					unauthenticated.has(key) ? undefined : [{ AdminBearerAuth: [] }],
				);
				const parameters = JSON.stringify(operation.parameters);
				expect(parameters, key).toContain(
					"#/components/parameters/ClientAdminContractVersion",
				);
				expect(parameters, key).toContain(
					"#/components/parameters/AdminDeviceId",
				);
				for (const responseOrReference of Object.values(
					objectValue(operation, "responses"),
				)) {
					const response = dereference(responseOrReference);
					if (!isObject(response))
						throw new Error(`Invalid response for ${key}`);
					const headers = objectValue(response, "headers");
					const documentedHeader = dereference(
						headers[ADMIN_CONTRACT_VERSION_HEADER],
					);
					expect(documentedHeader, key).toMatchObject({
						required: true,
						schema: {
							type: "string",
							const: CURRENT_ADMIN_CONTRACT_VERSION,
						},
					});
				}
			}
		}

		const authenticationOptions = documentedSchema(
			"AdminAuthenticationOptions",
		);
		const authenticationProperties = objectValue(
			authenticationOptions,
			"properties",
		);
		expect(
			objectValue(authenticationProperties, "allowCredentials").maxItems,
		).toBe(0);
		expect(
			objectValue(authenticationProperties, "userVerification").const,
		).toBe("required");
		const registrationSelection = objectValue(
			objectValue(
				objectValue(documentedSchema("AdminRegistrationOptions"), "properties"),
				"authenticatorSelection",
			),
			"properties",
		);
		expect(objectValue(registrationSelection, "residentKey").const).toBe(
			"required",
		);
		expect(objectValue(registrationSelection, "userVerification").const).toBe(
			"required",
		);

		const auditProperties = objectValue(
			documentedSchema("AdminAuditEvent"),
			"properties",
		);
		expect(Object.keys(auditProperties)).toEqual([
			"auditEventId",
			"action",
			"targetType",
			"occurredAt",
		]);
		expect(JSON.stringify(auditProperties)).not.toMatch(
			/hash|context|login|credentialId|ip|userAgent/i,
		);
	});

	it("keeps Zod request and response constraints in sync", () => {
		const comparisons = [
			["RecommendationContext", RecommendationContextSchema, "input"],
			["RecommendationEvent", RecommendationEventSchema, "input"],
			[
				"RecommendationResultReferenceInput",
				RecommendationResultReferenceInputSchema,
				"input",
			],
			["FavoriteMutationRequest", FavoriteMutationRequestSchema, "input"],
			["UpdateFavoriteGroupRequest", UpdateFavoriteGroupRequestSchema, "input"],
			[
				"PersistedPlacePresentation",
				PersistedPlacePresentationSchema,
				"output",
			],
			["FavoriteRecord", FavoriteRecordSchema, "output"],
			["ListFavoritesQuery", ListFavoritesQuerySchema, "input"],
			["FavoritesPage", FavoritesPageSchema, "output"],
			["RecommendationHistoryItem", RecommendationHistoryItemSchema, "output"],
			[
				"ListRecommendationHistoryQuery",
				ListRecommendationHistoryQuerySchema,
				"input",
			],
			["RecommendationHistoryPage", RecommendationHistoryPageSchema, "output"],
			[
				"CreatePrivateFeedbackRequest",
				CreatePrivateFeedbackRequestSchema,
				"input",
			],
			["PrivateFeedbackRecord", PrivateFeedbackRecordSchema, "output"],
			["ListPrivateFeedbackQuery", ListPrivateFeedbackQuerySchema, "input"],
			["PrivateFeedbackPage", PrivateFeedbackPageSchema, "output"],
			["FavoriteIdPath", FavoriteIdPathSchema, "input"],
			["FeedbackIdPath", FeedbackIdPathSchema, "input"],
			["PersistenceCapabilities", PersistenceCapabilitiesSchema, "output"],
			["ServiceCapabilities", ServiceCapabilitiesSchema, "output"],
			["FeatureConfig", FeatureConfigSchema, "output"],
			["LocationSearchRequest", LocationSearchRequestSchema, "input"],
			["LocationSearchResponse", LocationSearchResponseSchema, "output"],
			["PlaceSearchRequest", PlaceSearchRequestSchema, "input"],
			["PlaceSearchResponse", PlaceSearchResponseSchema, "output"],
			["RecommendationResponse", RecommendationResponseSchema, "output"],
			["SupportFeedbackCategory", SupportFeedbackCategorySchema, "input"],
			["SupportFeedbackResponse", SupportFeedbackResponseSchema, "output"],
			["AuthCapabilities", AuthCapabilitiesSchema, "output"],
			["PhoneRequestCode", PhoneRequestCodeSchema, "input"],
			["EmailRequestCode", EmailRequestCodeSchema, "input"],
			[
				"PhoneCodeChallengeResponse",
				PhoneCodeChallengeResponseSchema,
				"output",
			],
			[
				"EmailCodeChallengeResponse",
				EmailCodeChallengeResponseSchema,
				"output",
			],
			["OAuthStateRequest", OAuthStateRequestSchema, "input"],
			["OAuthStateResponse", OAuthStateResponseSchema, "output"],
			["LoginRequest", LoginRequestSchema, "input"],
			["AuthTokenResponse", AuthTokenResponseSchema, "output"],
			["RefreshRequest", RefreshRequestSchema, "input"],
			["LogoutRequest", LogoutRequestSchema, "input"],
			["LogoutResponse", LogoutResponseSchema, "output"],
			["IdentityBindingsResponse", IdentityBindingsResponseSchema, "output"],
			["BindIdentityRequest", BindIdentityRequestSchema, "input"],
			["BindIdentityResponse", BindIdentityResponseSchema, "output"],
			["BindingIdPath", BindingIdPathSchema, "input"],
			["UnbindIdentityResponse", UnbindIdentityResponseSchema, "output"],
			["SessionsResponse", SessionsResponseSchema, "output"],
			["SessionIdPath", SessionIdPathSchema, "input"],
			["RevokeSessionResponse", RevokeSessionResponseSchema, "output"],
			["AccountExportRequest", AccountExportRequestSchema, "input"],
			["AccountExportResponse", AccountExportResponseSchema, "output"],
			["AccountExportIdPath", AccountExportIdPathSchema, "input"],
			[
				"AccountExportStatusResponse",
				AccountExportStatusResponseSchema,
				"output",
			],
			[
				"LatestAccountExportResponse",
				LatestAccountExportResponseSchema,
				"output",
			],
			["DeleteAccountRequest", DeleteAccountRequestSchema, "input"],
			["DeleteAccountResponse", DeleteAccountResponseSchema, "output"],
			[
				"AdminAuthenticationOptions",
				AdminAuthenticationOptionsSchema,
				"output",
			],
			["AdminLoginOptionsResponse", AdminLoginOptionsResponseSchema, "output"],
			["AdminLoginVerifyResponse", AdminLoginVerifyResponseSchema, "output"],
			[
				"AdminCurrentSessionResponse",
				AdminCurrentSessionResponseSchema,
				"output",
			],
			["AdminCredentialsResponse", AdminCredentialsResponseSchema, "output"],
			[
				"AdminCredentialEnrollVerifyResponse",
				AdminCredentialEnrollVerifyResponseSchema,
				"output",
			],
			["AdminAuditEvent", AdminAuditEventSchema, "output"],
			["AdminAuditPageResponse", AdminAuditPageResponseSchema, "output"],
		] as const;

		for (const [name, schema, io] of comparisons) {
			expect(
				contractProjection(dereference(documentedSchema(name))),
				name,
			).toEqual(zodJsonSchema(schema, io));
		}
	});

	it("enforces account creation, binding-only methods and Bearer boundaries", () => {
		const bearer = objectValue(
			openApi.components.securitySchemes,
			"BearerAuth",
		);
		expect(bearer).toMatchObject({
			type: "http",
			scheme: "bearer",
			bearerFormat: "opaque",
		});

		const phonePurpose = objectValue(
			objectValue(documentedSchema("PhoneRequestCode"), "properties"),
			"purpose",
		);
		expect(phonePurpose.enum).toEqual(["REGISTER", "LOGIN"]);
		const emailPurpose = objectValue(
			objectValue(documentedSchema("EmailRequestCode"), "properties"),
			"purpose",
		);
		expect(emailPurpose.enum).toEqual(["LOGIN", "BIND"]);

		const oauthRequest = documentedSchema("OAuthStateRequest");
		const oauthBranches = oauthRequest.anyOf;
		if (!Array.isArray(oauthBranches)) {
			throw new Error("OAuthStateRequest must be a discriminated union");
		}
		const requestPurposesFor = (providerName: "WECHAT" | "QQ") =>
			oauthBranches.flatMap((branch) => {
				if (!isObject(branch)) return [];
				const properties = objectValue(branch, "properties");
				const provider = objectValue(properties, "provider");
				const supportsProvider =
					provider.const === providerName ||
					(Array.isArray(provider.enum) &&
						provider.enum.includes(providerName));
				if (!supportsProvider) return [];
				const purpose = objectValue(properties, "purpose").const;
				return typeof purpose === "string" ? [purpose] : [];
			});
		expect([...new Set(requestPurposesFor("WECHAT"))].sort()).toEqual([
			"BIND",
			"LOGIN",
		]);
		expect(requestPurposesFor("QQ").sort()).toEqual(["BIND", "LOGIN"]);
		const registrationRequests = oauthBranches.filter(
			(branch) =>
				isObject(branch) &&
				objectValue(objectValue(branch, "properties"), "purpose").const ===
					"REGISTER",
		);
		expect(registrationRequests).toHaveLength(0);

		const oauthResponse = documentedSchema("OAuthStateResponse");
		const responseBranches = oauthResponse.oneOf;
		if (!Array.isArray(responseBranches)) {
			throw new Error("OAuthStateResponse must be a discriminated union");
		}
		const responseFor = (providerName: "WECHAT" | "QQ") =>
			responseBranches.find(
				(branch) =>
					isObject(branch) &&
					objectValue(objectValue(branch, "properties"), "provider").const ===
						providerName,
			);
		const wechatResponse = responseFor("WECHAT");
		if (!isObject(wechatResponse))
			throw new Error("Missing WeChat OAuth response branch");
		expect(
			objectValue(objectValue(wechatResponse, "properties"), "purpose").enum,
		).toEqual(["LOGIN", "BIND"]);
		const qqResponse = responseFor("QQ");
		if (!isObject(qqResponse))
			throw new Error("Missing QQ OAuth response branch");
		expect(
			objectValue(objectValue(qqResponse, "properties"), "purpose").enum,
		).toEqual(["LOGIN", "BIND"]);

		const bindRequest = documentedSchema("BindIdentityRequest");
		if (!Array.isArray(bindRequest.oneOf)) {
			throw new Error("BindIdentityRequest must be a discriminated union");
		}
		const bindTypes = bindRequest.oneOf.flatMap((branch) => {
			if (!isObject(branch)) return [];
			const type = objectValue(objectValue(branch, "properties"), "type").const;
			return typeof type === "string" ? [type] : [];
		});
		expect(bindTypes).toEqual(["EMAIL", "WECHAT", "QQ"]);

		const assertQqAuthorizationCodeProof = (
			schemaName: "LoginRequest" | "BindIdentityRequest",
			discriminator: "method" | "type",
		) => {
			const schema = documentedSchema(schemaName);
			if (!Array.isArray(schema.oneOf)) {
				throw new Error(`${schemaName} must be a discriminated union`);
			}
			const qqBranch = schema.oneOf.find(
				(branch) =>
					isObject(branch) &&
					objectValue(
						objectValue(branch, "properties"),
						discriminator,
					).const === "QQ",
			);
			if (!isObject(qqBranch)) {
				throw new Error(`Missing QQ branch in ${schemaName}`);
			}
			const properties = objectValue(qqBranch, "properties");
			expect(properties.authorizationCode).toEqual({
				$ref: "#/components/schemas/ThirdPartyAuthorizationCode",
			});
			expect(properties).not.toHaveProperty("accessToken");
			expect(properties).not.toHaveProperty("openId");
			expect(qqBranch.additionalProperties).toBe(false);
			expect(qqBranch.required).toContain("authorizationCode");
			expect(qqBranch.required).not.toContain("accessToken");
		};
		assertQqAuthorizationCodeProof("LoginRequest", "method");
		assertQqAuthorizationCodeProof("BindIdentityRequest", "type");
		expect(openApi.components.schemas).not.toHaveProperty(
			"ThirdPartyAccessToken",
		);

		const authenticatedOperations = [
			["/v1/favorites", "get"],
			["/v1/favorites", "post"],
			["/v1/favorites/{favoriteId}/group", "post"],
			["/v1/favorites/{favoriteId}", "delete"],
			["/v1/history", "get"],
			["/v1/history", "delete"],
			["/v1/private-feedback", "get"],
			["/v1/private-feedback", "post"],
			["/v1/private-feedback", "delete"],
			["/v1/private-feedback/{feedbackId}", "delete"],
			["/v1/auth/logout", "post"],
			["/v1/auth/identities", "get"],
			["/v1/auth/identities", "post"],
			["/v1/auth/identities/{bindingId}", "delete"],
			["/v1/auth/sessions", "get"],
			["/v1/auth/sessions/{sessionId}", "delete"],
			["/v1/account/export", "post"],
			["/v1/account/exports/latest", "get"],
			["/v1/account/exports/{exportId}", "get"],
			["/v1/account/exports/{exportId}/content", "get"],
			["/v1/account", "delete"],
		] as const satisfies readonly (readonly [string, HttpMethod])[];
		for (const [path, method] of authenticatedOperations) {
			expect(pathOperation(path, method).security).toEqual([
				{ BearerAuth: [] },
			]);
		}
		expect(pathOperation("/v1/auth/oauth/state", "post").security).toEqual([
			{},
			{ BearerAuth: [] },
		]);
		const emailCodeOperation = pathOperation(
			"/v1/auth/email/request-code",
			"post",
		);
		expect(emailCodeOperation.security).toEqual([{}, { BearerAuth: [] }]);
		expect(Object.keys(objectValue(emailCodeOperation, "responses"))).toContain(
			"401",
		);
		expect(pathOperation("/v1/recommendation-events", "post").security).toEqual(
			[{}, { BearerAuth: [] }],
		);
		expect(pathOperation("/v1/support-feedback", "post").security).toEqual([
			{},
			{ BearerAuth: [] },
		]);
	});

	it("keeps support feedback body-only, write-only and response-minimal", () => {
		expect(
			collectReferenceLocations(
				openApi.paths,
				"#/components/schemas/SupportFeedbackRequest",
			),
		).toEqual([
			"/v1/support-feedback.post.requestBody.content.application/json.schema.$ref",
		]);

		const request = documentedSchema("SupportFeedbackRequest");
		expect(request.additionalProperties).toBe(false);
		expect(request.required).toEqual(["submissionId", "category", "message"]);
		const requestProperties = objectValue(request, "properties");
		expect(objectValue(requestProperties, "submissionId")).toMatchObject({
			type: "string",
			pattern:
				"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
			writeOnly: true,
			"x-sensitive": "idempotency-key",
		});
		expect(objectValue(requestProperties, "message")).toMatchObject({
			type: "string",
			minLength: 10,
			maxLength: 2_000,
			writeOnly: true,
			"x-sensitive": "support-message",
		});

		const response = documentedSchema("SupportFeedbackResponse");
		expect(Object.keys(objectValue(response, "properties"))).toEqual([
			"feedbackId",
			"accepted",
			"retentionAfterClosureDays",
		]);
		expect(JSON.stringify(response)).not.toMatch(
			/message|fingerprint|keyVersion|guestIp|userId|ciphertext/i,
		);
	});

	it("keeps account export delivery owner-authenticated and storage-neutral", () => {
		const statusSchema = JSON.stringify(
			documentedSchema("AccountExportStatusResponse"),
		);
		expect(statusSchema).not.toMatch(
			/locator|objectKey|bucket|signedUrl|downloadToken|keyVersion|ciphertext/iu,
		);
		expect(statusSchema).toContain('"GENERATION_FAILED"');
		expect(statusSchema).toContain('"maximum":10485760');

		const content = dereference(
			objectValue(
				pathOperation("/v1/account/exports/{exportId}/content", "get"),
				"responses",
			)["200"],
		);
		if (!isObject(content)) throw new Error("Invalid export content response");
		const headers = objectValue(content, "headers");
		expect(Object.keys(headers)).toEqual([
			"X-ChiShenMe-Contract-Version",
			"Content-Length",
			"Digest",
			"X-Content-SHA256",
			"Content-Disposition",
			"Cache-Control",
		]);
		expect(JSON.stringify(content)).not.toMatch(
			/https?:|location|redirect|object.?storage/iu,
		);
		expect(
			objectValue(objectValue(headers, "Content-Disposition"), "schema").const,
		).toBe('attachment; filename="chi-shen-me-account-export.json"');
	});

	it("keeps provider credentials and raw identities out of every auth response", () => {
		const authSuccesses = [
			["/v1/auth/phone/request-code", "post", "202"],
			["/v1/auth/email/request-code", "post", "202"],
			["/v1/auth/oauth/state", "post", "201"],
			["/v1/auth/login", "post", "200"],
			["/v1/auth/refresh", "post", "200"],
			["/v1/auth/logout", "post", "200"],
			["/v1/auth/identities", "get", "200"],
			["/v1/auth/identities", "post", "201"],
			["/v1/auth/identities/{bindingId}", "delete", "200"],
			["/v1/auth/sessions", "get", "200"],
			["/v1/auth/sessions/{sessionId}", "delete", "200"],
			["/v1/account/export", "post", "202"],
			["/v1/account/exports/latest", "get", "200"],
			["/v1/account/exports/{exportId}", "get", "200"],
			["/v1/account/exports/{exportId}/content", "get", "200"],
			["/v1/account", "delete", "202"],
		] as const satisfies readonly (readonly [string, HttpMethod, string])[];

		for (const [path, method, status] of authSuccesses) {
			const response = dereference(
				objectValue(pathOperation(path, method), "responses")[status],
			);
			if (!isObject(response)) throw new Error(`Invalid ${method} ${path}`);
			const content = objectValue(response, "content");
			const mediaType = objectValue(content, "application/json");
			const responseSchema = dereference(mediaType.schema);
			expect(JSON.stringify(responseSchema)).not.toMatch(
				/"(?:authorizationCode|wechatAuthorizationCode|openId|appSecret|appKey|providerAccessToken|providerRefreshToken|phoneNumber|email)"/u,
			);
		}

		const capabilities = JSON.stringify(documentedSchema("AuthCapabilities"));
		expect(capabilities).not.toMatch(
			/appSecret|appKey|templateId|senderAddress|providerToken/i,
		);
		expect(JSON.stringify(openApi.components.schemas)).not.toMatch(
			/"(?:appSecret|appKey|providerSecret|providerRefreshToken)"/u,
		);
	});

	it("does not publish retired Fusion or combined-registration surfaces", () => {
		for (const retiredPath of [
			"/v1/auth/phone/fusion-token",
			"/v1/auth/phone/fusion-verify",
			"/v1/auth/register/phone-wechat",
			"/v1/auth/register/fusion-wechat",
		]) {
			expect(openApi.paths).not.toHaveProperty(retiredPath);
		}
		expect(JSON.stringify(openApi.components.schemas)).not.toMatch(
			/FusionAuth|RegisterPhoneWechat|RegisterFusionWechat/u,
		);
	});

	it("keeps location lookup in the JSON body and provider-neutral on the public wire", () => {
		expect(
			collectReferenceLocations(
				openApi.paths,
				"#/components/schemas/LocationSearchRequest",
			),
		).toEqual([
			"/v1/location-search.post.requestBody.content.application/json.schema.$ref",
		]);

		const request = documentedSchema("LocationSearchRequest");
		const query = objectValue(objectValue(request, "properties"), "query");
		expect(query.writeOnly).toBe(true);
		expect(query["x-sensitive"]).toBe("user-location-query");

		const response = documentedSchema("LocationSearchResponse");
		const responseText = JSON.stringify(response);
		expect(responseText).not.toMatch(/providerPlaceId|providerId|Amap/i);
		const responseProperties = objectValue(response, "properties");
		expect(objectValue(responseProperties, "dataSource")).toEqual({
			type: "string",
			pattern: "^[A-Z][A-Z0-9_]{1,31}$",
		});
		expect(objectValue(responseProperties, "dataMode").enum).toEqual([
			"LIVE",
			"DEMO",
		]);
	});

	it("keeps nearby restaurant keyword search body-only and provider-neutral", () => {
		expect(
			collectReferenceLocations(
				openApi.paths,
				"#/components/schemas/PlaceSearchRequest",
			),
		).toEqual([
			"/v1/place-search.post.requestBody.content.application/json.schema.$ref",
		]);

		const operation = pathOperation("/v1/place-search", "post");
		expect(operation.parameters).toEqual([
			{ $ref: "#/components/parameters/RequestCorrelationId" },
			{ $ref: "#/components/parameters/ClientContractVersion" },
		]);
		const request = documentedSchema("PlaceSearchRequest");
		const properties = objectValue(request, "properties");
		expect(objectValue(properties, "location")["x-sensitive"]).toBe(
			"precise-location",
		);
		expect(objectValue(properties, "keyword")["x-sensitive"]).toBe(
			"user-place-keyword",
		);

		const placeSearchResponse = dereference(
			documentedSchema("PlaceSearchResponse"),
		);
		if (!isObject(placeSearchResponse)) {
			throw new Error("Invalid PlaceSearchResponse schema");
		}
		const responseText = JSON.stringify(placeSearchResponse);
		expect(responseText).not.toMatch(
			/providerPlaceId|providerId|dataSource|fitScore|reasons|aiAssisted|phone|imageUrl|Amap/i,
		);
		expect(responseText).toContain('"navigate"');
		expect(responseText).toContain('"copyAddress"');
		expect(
			objectValue(objectValue(placeSearchResponse, "properties"), "coverage"),
		).toEqual({ type: "string", const: "NATIONWIDE" });
	});

	it("documents nationwide recommendation coverage as the only value", () => {
		const properties = objectValue(
			documentedSchema("RecommendationResponse"),
			"properties",
		);
		expect(objectValue(properties, "coverage")).toEqual({
			type: "string",
			const: "NATIONWIDE",
		});
	});

	it("freezes privacy-safe saved-resource, idempotency and rights boundaries", () => {
		const createFavorite = pathOperation("/v1/favorites", "post");
		const createFeedback = pathOperation("/v1/private-feedback", "post");
		for (const operation of [createFavorite, createFeedback]) {
			expect(operation.security).toEqual([{ BearerAuth: [] }]);
			expect(objectValue(operation, "responses")["403"]).toEqual({
				$ref: "#/components/responses/PersistenceForbidden",
			});
			expect(objectValue(operation, "responses")["410"]).toEqual({
				$ref: "#/components/responses/ResultReferenceExpired",
			});
			expect(String(operation.description)).toContain("LIVE_DISPLAY_ONLY");
			expect(String(operation.description)).toContain("idempotencyKey");
		}

		const favoriteRequest = documentedSchema("FavoriteMutationRequest");
		const favoriteRequestProperties = objectValue(
			favoriteRequest,
			"properties",
		);
		expect(favoriteRequest.required).toEqual([
			"idempotencyKey",
			"result",
			"group",
		]);
		expect(
			objectValue(favoriteRequestProperties, "idempotencyKey")["x-sensitive"],
		).toBe("idempotency-key");

		const durableSchemas = [
			"PersistedPlacePresentation",
			"FavoriteRecord",
			"FavoritesPage",
			"RecommendationHistoryItem",
			"RecommendationHistoryPage",
			"PrivateFeedbackRecord",
			"PrivateFeedbackPage",
		].map((name) =>
			JSON.stringify(contractProjection(dereference(documentedSchema(name)))),
		);
		for (const schemaText of durableSchemas) {
			expect(schemaText).not.toMatch(
				/"(?:providerPlaceId|providerId|resultToken|latitude|longitude|accuracyMeters|phone|secret|accessToken|refreshToken)"\s*:/i,
			);
		}

		const presentation = documentedSchema("PersistedPlacePresentation");
		const branches = presentation.oneOf;
		if (!Array.isArray(branches)) {
			throw new Error("PersistedPlacePresentation must be a union");
		}
		const available = branches.find(
			(branch) =>
				isObject(branch) &&
				objectValue(objectValue(branch, "properties"), "presentationStatus")
					.const === "AVAILABLE",
		);
		if (!isObject(available)) throw new Error("Missing AVAILABLE presentation");
		const availableProperties = objectValue(available, "properties");
		expect(objectValue(availableProperties, "dataMode").const).toBe("LIVE");
		expect(availableProperties).not.toHaveProperty("actions");

		const configProperties = objectValue(
			documentedSchema("FeatureConfig"),
			"properties",
		);
		expect(configProperties.persistenceCapabilities).toMatchObject({
			$ref: "#/components/schemas/PersistenceCapabilities",
		});
		expect(configProperties.supportFeedbackEnabled).toMatchObject({
			type: "boolean",
			default: false,
		});
	});

	it("documents canonical bounded query pagination and idempotent deletion", () => {
		const pageLimit = objectValue(openApi.components.parameters, "PageLimit");
		expect(pageLimit).toMatchObject({
			name: "limit",
			in: "query",
			required: false,
			schema: {
				type: "string",
				default: "20",
				pattern: "^(?:[1-9]|[1-4][0-9]|50)$",
			},
		});

		for (const path of [
			"/v1/favorites",
			"/v1/history",
			"/v1/private-feedback",
		]) {
			const parameters = pathOperation(path, "get").parameters;
			expect(JSON.stringify(parameters)).toContain(
				"#/components/parameters/PageCursor",
			);
			expect(JSON.stringify(parameters)).toContain(
				"#/components/parameters/PageLimit",
			);
		}

		for (const [path, method] of [
			["/v1/favorites/{favoriteId}", "delete"],
			["/v1/history", "delete"],
			["/v1/private-feedback", "delete"],
			["/v1/private-feedback/{feedbackId}", "delete"],
		] as const satisfies readonly (readonly [string, HttpMethod])[]) {
			const response = dereference(
				objectValue(pathOperation(path, method), "responses")["204"],
			);
			if (!isObject(response))
				throw new Error(`Invalid 204 response for ${path}`);
			expect(response).not.toHaveProperty("content");
			expect(String(pathOperation(path, method).description)).toContain("幂等");
		}
	});

	it("allows RecommendationContext coordinates only in the recommendation POST body", () => {
		expect(
			collectReferenceLocations(
				openApi.paths,
				"#/components/schemas/RecommendationContext",
			),
		).toEqual([
			"/v1/recommendations.post.requestBody.content.application/json.schema.$ref",
		]);

		const context = documentedSchema("RecommendationContext");
		const location = objectValue(
			objectValue(context, "properties"),
			"location",
		);
		expect(location.writeOnly).toBe(true);
		expect(location["x-sensitive"]).toBe("precise-location");

		const event = documentedSchema("RecommendationEvent");
		expect(event.additionalProperties).toBe(false);
		const eventProperties = objectValue(event, "properties");
		expect(Object.keys(eventProperties)).toEqual([
			"requestId",
			"resultToken",
			"type",
			"occurredAt",
		]);
		expect(JSON.stringify(event)).not.toContain("providerPlaceId");

		for (const [path, pathItem] of Object.entries(openApi.paths)) {
			if (!isObject(pathItem)) throw new Error(`Invalid path item ${path}`);
			for (const method of ["get", "post", "delete"] as const) {
				if (!(method in pathItem)) continue;
				const parameters = pathOperation(path, method).parameters;
				expect(JSON.stringify(parameters)).not.toMatch(
					/latitude|longitude|accuracyMeters|location|crs/i,
				);
			}
		}
	});

	it("freezes the implemented JSON transport error contract", () => {
		const expectedProblems = {
			InvalidJsonError: {
				code: "INVALID_JSON",
				message: "请求体不是有效的 JSON",
			},
			PayloadTooLargeError: {
				code: "PAYLOAD_TOO_LARGE",
				message: "请求体不能超过 100 KiB",
			},
			SupportFeedbackConflictError: {
				code: "SUPPORT_FEEDBACK_IDEMPOTENCY_CONFLICT",
				message: "反馈提交标识已被其他内容使用，请重新提交",
			},
			SupportFeedbackRateLimitError: {
				code: "SUPPORT_FEEDBACK_RATE_LIMITED",
				message: "反馈提交过于频繁，请稍后再试",
			},
			SupportFeedbackUnavailableError: {
				code: "SUPPORT_FEEDBACK_UNAVAILABLE",
				message: "反馈服务暂时不可用，请稍后重试",
			},
		} as const;

		for (const [name, problem] of Object.entries(expectedProblems)) {
			const properties = objectValue(documentedSchema(name), "properties");
			expect(objectValue(properties, "code").const).toBe(problem.code);
			expect(objectValue(properties, "message").const).toBe(problem.message);
		}

		const unsupportedProperties = objectValue(
			documentedSchema("UnsupportedMediaTypeError"),
			"properties",
		);
		expect(objectValue(unsupportedProperties, "code").const).toBe(
			"UNSUPPORTED_MEDIA_TYPE",
		);
		expect(objectValue(unsupportedProperties, "message").enum).toEqual([
			"Content-Type 必须为 application/json",
			"请求体编码不受支持",
		]);

		const rateLimitProperties = objectValue(
			documentedSchema("RateLimitError"),
			"properties",
		);
		expect(objectValue(rateLimitProperties, "retryAfterSeconds")).toMatchObject(
			{
				type: "integer",
				minimum: 1,
				maximum: 60,
			},
		);
		const rateLimitedResponse = objectValue(
			openApi.components.responses,
			"RateLimited",
		);
		const rateLimitedHeaders = objectValue(rateLimitedResponse, "headers");
		expect(objectValue(rateLimitedHeaders, "Retry-After")).toMatchObject({
			schema: { type: "integer", minimum: 1 },
		});
	});

	it("freezes a sanitized readiness contract without upstream probing details", () => {
		const operation = pathOperation("/health/ready", "get");
		const responses = objectValue(operation, "responses");
		const success = dereference(responses["200"]);
		const unavailable = dereference(responses["503"]);
		if (!isObject(success) || !isObject(unavailable)) {
			throw new Error("Invalid readiness responses");
		}

		const successSchema = dereference(
			objectValue(
				objectValue(objectValue(success, "content"), "application/json"),
				"schema",
			),
		);
		expect(successSchema).toEqual({
			type: "object",
			properties: {
				status: { const: "ready" },
				timestamp: { type: "string", format: "date-time" },
			},
			required: ["status", "timestamp"],
			additionalProperties: false,
		});

		const errorSchema = dereference(
			objectValue(
				objectValue(objectValue(unavailable, "content"), "application/json"),
				"schema",
			),
		);
		if (!isObject(errorSchema))
			throw new Error("Invalid readiness error schema");
		const properties = objectValue(errorSchema, "properties");
		expect(Object.keys(properties)).toEqual(["requestId", "code", "message"]);
		expect(objectValue(properties, "code").const).toBe("SERVICE_NOT_READY");
		expect(objectValue(properties, "message").const).toBe(
			"服务尚未就绪，请稍后重试",
		);
		expect(JSON.stringify(errorSchema)).not.toMatch(
			/database|postgres|amap|provider|credential|secret/iu,
		);
	});

	it("freezes fail-closed service capability names without provider identity", () => {
		const capabilities = documentedSchema("ServiceCapabilities");
		const properties = objectValue(capabilities, "properties");
		expect(Object.keys(properties)).toEqual([
			"recommendationsEnabled",
			"locationSearchEnabled",
			"placeSearchEnabled",
		]);
		for (const property of Object.values(properties)) {
			expect(property).toMatchObject({ type: "boolean", default: false });
		}
		expect(capabilities.required).toEqual(Object.keys(properties));
		expect(capabilities.additionalProperties).toBe(false);
		expect(JSON.stringify(capabilities)).not.toMatch(
			/amap|provider|credential|secret|apiKey/iu,
		);

		const configProperties = objectValue(
			documentedSchema("FeatureConfig"),
			"properties",
		);
		const advertised = objectValue(configProperties, "serviceCapabilities");
		expect(advertised.default).toEqual({
			recommendationsEnabled: false,
			locationSearchEnabled: false,
			placeSearchEnabled: false,
		});
	});

	it("documents vendor-neutral recommendation sources and strict action capabilities", () => {
		const result = documentedSchema("RecommendationResult");
		expect(result).not.toHaveProperty("allOf");
		const properties = objectValue(result, "properties");
		expect(objectValue(properties, "provider")).toEqual({
			type: "string",
			pattern: "^[A-Z][A-Z0-9_]{1,31}$",
		});
		expect(objectValue(properties, "resultToken")).toMatchObject({
			type: "string",
			minLength: 43,
			maxLength: 43,
			pattern: "^[A-Za-z0-9_-]{43}$",
		});
		expect(JSON.stringify(result)).not.toContain("providerPlaceId");
		expect(objectValue(properties, "dataMode").enum).toEqual(["LIVE", "DEMO"]);
		const actionSchema = dereference(
			objectValue(properties, "actions"),
		) as JsonObject;
		const actions = objectValue(actionSchema, "properties");
		expect(Object.keys(actions)).toEqual([
			"navigate",
			"call",
			"copyAddress",
			"share",
		]);
		expect(actionSchema.required).toEqual([
			"navigate",
			"call",
			"copyAddress",
			"share",
		]);
		expect(actionSchema.additionalProperties).toBe(false);
		expect(
			apiSource("apps/api/src/recommendations/domain/recommendation-engine.ts"),
		).not.toContain("AMAP");

		const common = {
			provider: "AUTHORIZED_VENDOR",
			resultToken: "A".repeat(43),
			dataMode: "LIVE",
			actions: {
				navigate: true,
				call: false,
				copyAddress: true,
				share: false,
			},
			name: "测试餐厅",
			address: "测试地址",
			rank: 1,
			fitScore: null,
			sourceRating: null,
			averageCostYuan: null,
			distanceMeters: 100,
			estimatedTravelMinutes: 2,
			estimatedMealMinutes: 30,
			openStatus: "UNKNOWN",
			tags: [],
			imageUrl: null,
			phone: null,
			reasons: [{ code: "DISTANCE_FIT", text: "距离较近" }],
			warnings: [],
			confidence: "LOW",
			aiAssisted: false,
			sourceAttribution: "已授权数据源",
		};
		expect(
			RecommendationResultSchema.safeParse({
				...common,
				location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" },
			}).success,
		).toBe(true);
		expect(
			RecommendationResultSchema.safeParse({
				...common,
				provider: "invalid-provider",
				location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" },
			}).success,
		).toBe(false);
	});
});
