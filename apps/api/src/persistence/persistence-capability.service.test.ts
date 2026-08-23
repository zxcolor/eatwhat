import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { type AppConfig, loadAppConfig } from "../config/app-config.js";
import type { DataRightsPolicy } from "../config/data-rights-policy.js";
import {
	type PersistenceCapabilityKind,
	PersistenceCapabilityService,
} from "./persistence-support.js";
import type { PlacePresentationResolver } from "./place-presentation.resolver.js";

const AUTHORIZATION_ID = "11111111-1111-4111-8111-111111111111";

function config(input?: {
	accounts?: boolean;
	favorites?: boolean;
	history?: boolean;
	privateFeedback?: boolean;
}): AppConfig {
	const base = loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@db.invalid:5432/chishenme",
		DATA_RIGHTS_MODE: "LICENSED_ENRICHMENT",
		DATA_RIGHTS_AUTHORIZATION_ID: AUTHORIZATION_ID,
		DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT: "2099-12-31T15:59:59.000Z",
	});
	return Object.freeze({
		...base,
		features: Object.freeze({
			...base.features,
			accountsEnabled: input?.accounts ?? true,
			favoritesEnabled: input?.favorites ?? false,
			historyEnabled: input?.history ?? false,
			privateFeedbackEnabled: input?.privateFeedback ?? false,
		}),
	});
}

function rights(input?: {
	mode?: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
	persist?: boolean;
	failure?: Error;
}): DataRightsPolicy {
	return {
		effectiveMode: vi.fn(async () => {
			if (input?.failure !== undefined) throw input.failure;
			return input?.mode ?? "LICENSED_ENRICHMENT";
		}),
		canPersistPlaceReference: vi.fn(async () => {
			if (input?.failure !== undefined) throw input.failure;
			return input?.persist ?? true;
		}),
	} as unknown as DataRightsPolicy;
}

const presentations = {
	supportsLiveProvider: vi.fn((provider: string) => provider === "AMAP"),
} as unknown as PlacePresentationResolver;

function service(appConfig: AppConfig, policy = rights()) {
	return {
		policy,
		service: new PersistenceCapabilityService(appConfig, policy, presentations),
	};
}

async function expectForbidden(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
		throw new Error("expected forbidden");
	} catch (error) {
		expect(error).toBeInstanceOf(ForbiddenException);
		expect(error).toMatchObject({
			response: {
				code: "PERSISTENCE_CAPABILITY_DISABLED",
				message: "当前数据授权不允许保存餐厅引用",
			},
		});
	}
}

describe("PersistenceCapabilityService", () => {
	it.each([
		["FAVORITE", { favorites: true }],
		["HISTORY", { history: true }],
		["PRIVATE_FEEDBACK", { privateFeedback: true }],
	] as const)(
		"grants only an explicitly deployed %s capability",
		async (kind, flags) => {
			const { policy, service: capability } = service(config(flags));
			await expect(capability.requireGrant(kind, "AMAP")).resolves.toEqual({
				authorizationId: AUTHORIZATION_ID,
				retainUntil: "2099-12-31T15:59:59.000Z",
			});
			expect(policy.effectiveMode).toHaveBeenCalledWith("AMAP");
			expect(policy.canPersistPlaceReference).toHaveBeenCalledWith("AMAP");
		},
	);

	it.each([
		["FAVORITE", { history: true }],
		["HISTORY", { privateFeedback: true }],
		["PRIVATE_FEEDBACK", { favorites: true }],
	] as const)(
		"rejects a disabled %s before looking up rights",
		async (kind, flags) => {
			const { policy, service: capability } = service(config(flags));
			await expectForbidden(capability.requireGrant(kind, "AMAP"));
			expect(policy.effectiveMode).not.toHaveBeenCalled();
			expect(policy.canPersistPlaceReference).not.toHaveBeenCalled();
		},
	);

	it("rejects every kind before rights lookup when accounts are disabled", async () => {
		const { policy, service: capability } = service(
			config({
				accounts: false,
				favorites: true,
				history: true,
				privateFeedback: true,
			}),
		);
		for (const kind of [
			"FAVORITE",
			"HISTORY",
			"PRIVATE_FEEDBACK",
		] as const satisfies readonly PersistenceCapabilityKind[]) {
			await expectForbidden(capability.requireGrant(kind, "AMAP"));
		}
		expect(policy.effectiveMode).not.toHaveBeenCalled();
	});

	it.each([
		["effective live-only mode", rights({ mode: "LIVE_DISPLAY_ONLY" })],
		["persistence authorization revoked", rights({ persist: false })],
		[
			"database failure",
			rights({ failure: new Error("private database body") }),
		],
	] as const)(
		"fails closed for %s without leaking details",
		async (_name, policy) => {
			const capability = service(config({ favorites: true }), policy).service;
			await expectForbidden(capability.requireGrant("FAVORITE", "AMAP"));
		},
	);

	it.each(["DEMO", "UNKNOWN"])(
		"rejects unsupported provider %s without querying rights",
		async (provider) => {
			const { policy, service: capability } = service(
				config({ favorites: true }),
			);
			await expectForbidden(capability.requireGrant("FAVORITE", provider));
			expect(policy.effectiveMode).not.toHaveBeenCalled();
		},
	);

	it("rechecks the deployment switch after the asynchronous rights lookup", async () => {
		const base = config({ favorites: true });
		let reads = 0;
		const features = {
			...base.features,
			get favoritesEnabled() {
				reads += 1;
				return reads === 1;
			},
		};
		const changing = { ...base, features } as AppConfig;
		const capability = service(changing).service;
		await expectForbidden(capability.requireGrant("FAVORITE", "AMAP"));
		expect(reads).toBe(2);
	});
});
