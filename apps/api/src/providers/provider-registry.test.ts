import {
	type DataSourceCode,
	DataSourceCodeSchema,
} from "@chi-shen-me/contracts";
import { describe, expect, it } from "vitest";
import { ProviderCapability } from "./provider-catalog.js";
import {
	ProviderRegistry,
	ProviderSelector,
	providerDescriptor,
} from "./provider-registry.js";

interface TestAdapter {
	readonly code: DataSourceCode;
	readonly marker: string;
}

function code(value: string): DataSourceCode {
	return DataSourceCodeSchema.parse(value);
}

function registration(
	providerCode: string,
	capabilities: readonly ProviderCapability[],
	enabled = true,
	adapterCode = providerCode,
) {
	return {
		descriptor: providerDescriptor(code(providerCode), capabilities, enabled),
		adapter: {
			code: code(adapterCode),
			marker: providerCode,
		} satisfies TestAdapter,
	};
}

function selector(...registrations: ReturnType<typeof registration>[]) {
	return new ProviderSelector(
		new ProviderRegistry<TestAdapter>(registrations, (adapter) => adapter.code),
	);
}

describe("provider registry and selector", () => {
	it("selects the first enabled adapter in configured priority order", () => {
		const result = selector(
			registration("ALPHA", [ProviderCapability.PLACE_RECOMMENDATION]),
			registration("BRAVO", [ProviderCapability.PLACE_RECOMMENDATION]),
		).select(
			[code("BRAVO"), code("ALPHA")],
			ProviderCapability.PLACE_RECOMMENDATION,
		);

		expect(result.adapter?.marker).toBe("BRAVO");
		expect(result.diagnostic).toMatchObject({
			capability: "PLACE_RECOMMENDATION",
			selectedCode: "BRAVO",
			selectedPriorityIndex: 0,
			skipped: [],
		});
	});

	it("skips disabled adapters without changing configured priority", () => {
		const result = selector(
			registration("ALPHA", [ProviderCapability.PLACE_RECOMMENDATION], false),
			registration("BRAVO", [ProviderCapability.PLACE_RECOMMENDATION]),
		).select(
			[code("ALPHA"), code("BRAVO")],
			ProviderCapability.PLACE_RECOMMENDATION,
		);

		expect(result.adapter?.marker).toBe("BRAVO");
		expect(result.diagnostic.skipped).toEqual([
			{ code: "ALPHA", reason: "DISABLED" },
		]);
	});

	it("does not infer one capability from a provider that implements another", () => {
		const result = selector(
			registration("ALPHA", [ProviderCapability.PLACE_RECOMMENDATION]),
		).select([code("ALPHA")], ProviderCapability.LOCATION_TEXT_SEARCH);

		expect(result.adapter).toBeNull();
		expect(result.diagnostic.skipped).toEqual([
			{ code: "ALPHA", reason: "UNSUPPORTED_CAPABILITY" },
		]);
	});

	it("returns a sanitized no-selection diagnostic when no source is usable", () => {
		const result = selector(
			registration("ALPHA", [ProviderCapability.PLACE_RECOMMENDATION], false),
		).select(
			[code("MISSING"), code("ALPHA")],
			ProviderCapability.PLACE_RECOMMENDATION,
		);

		expect(result.adapter).toBeNull();
		expect(result.diagnostic).toEqual({
			capability: "PLACE_RECOMMENDATION",
			selectedCode: null,
			selectedPriorityIndex: null,
			skipped: [
				{ code: "MISSING", reason: "NOT_REGISTERED" },
				{ code: "ALPHA", reason: "DISABLED" },
			],
		});
		expect(JSON.stringify(result.diagnostic)).not.toContain("query");
		expect(JSON.stringify(result.diagnostic)).not.toContain("latitude");
	});

	it("rejects duplicate codes and descriptor-adapter identity mismatches", () => {
		expect(
			() =>
				new ProviderRegistry<TestAdapter>(
					[
						registration("ALPHA", [ProviderCapability.PLACE_RECOMMENDATION]),
						registration("ALPHA", [ProviderCapability.LOCATION_TEXT_SEARCH]),
					],
					(adapter) => adapter.code,
				),
		).toThrow("重复注册");
		expect(
			() =>
				new ProviderRegistry<TestAdapter>(
					[
						registration(
							"ALPHA",
							[ProviderCapability.PLACE_RECOMMENDATION],
							true,
							"BRAVO",
						),
					],
					(adapter) => adapter.code,
				),
		).toThrow("不一致");
	});

	it("rejects unknown capabilities at registration and selection runtime", () => {
		const unknown = "SECRET_CAPABILITY" as ProviderCapability;
		expect(
			() =>
				new ProviderRegistry<TestAdapter>(
					[registration("ALPHA", [unknown])],
					(adapter) => adapter.code,
				),
		).toThrow("未知能力");
		expect(() =>
			selector(
				registration("ALPHA", [ProviderCapability.PLACE_RECOMMENDATION]),
			).select([code("ALPHA")], unknown),
		).toThrow("未知供应商能力");
	});

	it("copies and freezes descriptor capabilities against external mutation", () => {
		const capabilities: ProviderCapability[] = [
			ProviderCapability.PLACE_RECOMMENDATION,
		];
		const descriptor = {
			code: code("ALPHA"),
			capabilities,
			enabled: true,
		};
		const registry = new ProviderRegistry<TestAdapter>(
			[{ descriptor, adapter: { code: code("ALPHA"), marker: "ALPHA" } }],
			(adapter) => adapter.code,
		);
		capabilities[0] = ProviderCapability.LOCATION_TEXT_SEARCH;

		const stored = registry.get(code("ALPHA"));
		expect(stored?.descriptor.capabilities).toEqual([
			ProviderCapability.PLACE_RECOMMENDATION,
		]);
		expect(Object.isFrozen(stored?.descriptor)).toBe(true);
		expect(Object.isFrozen(stored?.descriptor.capabilities)).toBe(true);
	});
});
