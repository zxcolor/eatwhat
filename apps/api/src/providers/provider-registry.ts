import {
	type DataSourceCode,
	DataSourceCodeSchema,
} from "@chi-shen-me/contracts";
import {
	ProviderCapability,
	type ProviderCapability as ProviderCapabilityType,
} from "./provider-catalog.js";

export interface ProviderDescriptor {
	readonly code: DataSourceCode;
	readonly capabilities: readonly ProviderCapabilityType[];
	readonly enabled: boolean;
}

export interface ProviderRegistration<Adapter> {
	readonly descriptor: ProviderDescriptor;
	readonly adapter: Adapter;
}

export type ProviderSkipReason =
	| "NOT_REGISTERED"
	| "DISABLED"
	| "UNSUPPORTED_CAPABILITY";

export interface ProviderSelectionDiagnostic {
	readonly capability: ProviderCapabilityType;
	readonly selectedCode: DataSourceCode | null;
	readonly selectedPriorityIndex: number | null;
	readonly skipped: readonly {
		readonly code: DataSourceCode;
		readonly reason: ProviderSkipReason;
	}[];
}

export interface ProviderSelection<Adapter> {
	readonly adapter: Adapter | null;
	/** Internal-only, sanitized selection metadata. Never include request data. */
	readonly diagnostic: ProviderSelectionDiagnostic;
}

/**
 * A small, provider-neutral registry. Adapter identity is supplied by the
 * caller because existing provider interfaces intentionally use different
 * property names at their domain boundaries.
 */
export class ProviderRegistry<Adapter> {
	readonly #registrations: ReadonlyMap<
		DataSourceCode,
		ProviderRegistration<Adapter>
	>;

	constructor(
		registrations: readonly ProviderRegistration<Adapter>[],
		adapterCode: (adapter: Adapter) => DataSourceCode,
	) {
		const entries = new Map<DataSourceCode, ProviderRegistration<Adapter>>();
		for (const registration of registrations) {
			const descriptorResult = DataSourceCodeSchema.safeParse(
				registration.descriptor.code,
			);
			const adapterResult = DataSourceCodeSchema.safeParse(
				adapterCode(registration.adapter),
			);
			if (!descriptorResult.success || !adapterResult.success) {
				throw new Error("供应商注册包含非法代码");
			}
			const descriptorCode = descriptorResult.data;
			const actualAdapterCode = adapterResult.data;
			if (descriptorCode !== actualAdapterCode) {
				throw new Error("供应商描述符代码与适配器代码不一致");
			}
			if (entries.has(descriptorCode)) {
				throw new Error("供应商代码重复注册");
			}
			if (registration.descriptor.capabilities.length === 0) {
				throw new Error("供应商必须声明至少一种能力");
			}
			if (
				registration.descriptor.capabilities.some(
					(capability) =>
						!Object.values(ProviderCapability).includes(capability),
				)
			) {
				throw new Error("供应商包含未知能力声明");
			}
			if (
				new Set(registration.descriptor.capabilities).size !==
				registration.descriptor.capabilities.length
			) {
				throw new Error("供应商能力声明不能重复");
			}
			const descriptor = Object.freeze({
				code: descriptorCode,
				capabilities: Object.freeze([...registration.descriptor.capabilities]),
				enabled: registration.descriptor.enabled,
			});
			entries.set(
				descriptorCode,
				Object.freeze({ descriptor, adapter: registration.adapter }),
			);
		}
		this.#registrations = entries;
	}

	get(code: DataSourceCode): ProviderRegistration<Adapter> | undefined {
		return this.#registrations.get(code);
	}
}

export class ProviderSelector<Adapter> {
	constructor(private readonly registry: ProviderRegistry<Adapter>) {}

	select(
		priority: readonly DataSourceCode[],
		capability: ProviderCapabilityType,
	): ProviderSelection<Adapter> {
		if (!Object.values(ProviderCapability).includes(capability)) {
			throw new Error("请求选择未知供应商能力");
		}
		const skipped: Array<{ code: DataSourceCode; reason: ProviderSkipReason }> =
			[];

		for (const [priorityIndex, code] of priority.entries()) {
			const registration = this.registry.get(code);
			if (registration === undefined) {
				skipped.push({ code, reason: "NOT_REGISTERED" });
				continue;
			}
			if (!registration.descriptor.capabilities.includes(capability)) {
				skipped.push({ code, reason: "UNSUPPORTED_CAPABILITY" });
				continue;
			}
			if (!registration.descriptor.enabled) {
				skipped.push({ code, reason: "DISABLED" });
				continue;
			}

			return Object.freeze({
				adapter: registration.adapter,
				diagnostic: Object.freeze({
					capability,
					selectedCode: code,
					selectedPriorityIndex: priorityIndex,
					skipped: Object.freeze(skipped.map((entry) => Object.freeze(entry))),
				}),
			});
		}

		return Object.freeze({
			adapter: null,
			diagnostic: Object.freeze({
				capability,
				selectedCode: null,
				selectedPriorityIndex: null,
				skipped: Object.freeze(skipped.map((entry) => Object.freeze(entry))),
			}),
		});
	}
}

export function providerDescriptor(
	code: DataSourceCode,
	capabilities: readonly ProviderCapabilityType[],
	enabled: boolean,
): ProviderDescriptor {
	return Object.freeze({
		code,
		capabilities: Object.freeze([...capabilities]),
		enabled,
	});
}
