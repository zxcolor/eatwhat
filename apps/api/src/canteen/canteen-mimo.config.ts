import { CANTEEN_MIMO_MODELS } from "@chi-shen-me/contracts";

export const CANTEEN_MIMO_CONFIG = Symbol("CANTEEN_MIMO_CONFIG");
export interface CanteenMimoConfig {
	readonly enabled: boolean;
	readonly apiKey: string | null;
	readonly model: (typeof CANTEEN_MIMO_MODELS)[number];
	readonly timeoutMs: number;
	readonly maxCallsPerMinute: number;
	readonly maxConcurrency: number;
}
function boundedInteger(
	raw: string | undefined,
	fallback: number,
	name: string,
	maximum: number,
): number {
	if (raw === undefined || raw === "") return fallback;
	if (!/^[1-9][0-9]*$/u.test(raw))
		throw new Error(`${name} must be a positive integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value > maximum)
		throw new Error(`${name} is outside its allowed range`);
	return value;
}
export function loadCanteenMimoConfig(
	env: NodeJS.ProcessEnv = process.env,
): CanteenMimoConfig {
	if (
		env.MIMO_ENABLED !== undefined &&
		!["", "true", "false"].includes(env.MIMO_ENABLED)
	)
		throw new Error("MIMO_ENABLED must be true or false");
	const enabled = env.MIMO_ENABLED === "true";
	const model = env.MIMO_MODEL || "mimo-v2.6-flash";
	if (!CANTEEN_MIMO_MODELS.some((entry) => entry === model))
		throw new Error("MIMO_MODEL must name a supported Xiaomi MiMo model");
	const key = env.MIMO_API_KEY?.trim();
	if (enabled && !key)
		throw new Error("MIMO_API_KEY is required when MIMO_ENABLED=true");
	return Object.freeze({
		enabled,
		apiKey: enabled ? (key ?? null) : null,
		model: model as CanteenMimoConfig["model"],
		timeoutMs: boundedInteger(
			env.MIMO_TIMEOUT_MS,
			8_000,
			"MIMO_TIMEOUT_MS",
			10_000,
		),
		maxCallsPerMinute: boundedInteger(
			env.MIMO_MAX_CALLS_PER_MINUTE,
			30,
			"MIMO_MAX_CALLS_PER_MINUTE",
			600,
		),
		maxConcurrency: boundedInteger(
			env.MIMO_MAX_CONCURRENCY,
			4,
			"MIMO_MAX_CONCURRENCY",
			20,
		),
	});
}
