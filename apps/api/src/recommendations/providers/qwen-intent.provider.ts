import {
	type IntentProfile,
	IntentProfileSchema,
	type RecommendationContext,
} from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { PromptSettings } from "../../operational-config/operational-config.types.js";
import {
	buildQwenSystemMessage,
	isRegisteredQwenModel,
	qwenSafeContext,
} from "./qwen-intent-registry.js";
import type { IntentProvider } from "./rule-intent.provider.js";

export const QWEN_FETCH = Symbol("QWEN_FETCH");

export class QwenIntentUnavailableError extends Error {
	constructor() {
		super("AI 意图服务暂时不可用");
		this.name = "QwenIntentUnavailableError";
	}
}

const INTENT_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"cuisineWeights",
		"mealTypes",
		"speedPreference",
		"diversityTarget",
		"explanationSeed",
	],
	properties: {
		cuisineWeights: {
			type: "object",
			additionalProperties: { type: "number", minimum: 0, maximum: 1 },
			maxProperties: 20,
		},
		mealTypes: {
			type: "array",
			minItems: 1,
			maxItems: 8,
			items: { type: "string", minLength: 1, maxLength: 30 },
		},
		speedPreference: { enum: ["FAST", "NORMAL", "RELAXED"] },
		diversityTarget: { type: "number", minimum: 0, maximum: 1 },
		explanationSeed: { type: "string", minLength: 1, maxLength: 160 },
	},
} as const;

function parseQwenContent(payload: unknown): IntentProfile {
	const root =
		typeof payload === "object" && payload !== null
			? (payload as Record<string, unknown>)
			: null;
	const choices = root?.choices;
	const first = Array.isArray(choices) ? choices[0] : null;
	const message =
		typeof first === "object" && first !== null
			? (first as Record<string, unknown>).message
			: null;
	const content =
		typeof message === "object" && message !== null
			? (message as Record<string, unknown>).content
			: null;
	if (
		typeof content !== "string" ||
		content.length === 0 ||
		content.length > 20_000
	) {
		throw new QwenIntentUnavailableError();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new QwenIntentUnavailableError();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new QwenIntentUnavailableError();
	}
	const raw = parsed as Record<string, unknown>;
	const weights = raw.cuisineWeights;
	if (
		typeof weights !== "object" ||
		weights === null ||
		Array.isArray(weights) ||
		Object.keys(weights).length > 20
	) {
		throw new QwenIntentUnavailableError();
	}
	if (
		!Array.isArray(raw.mealTypes) ||
		raw.mealTypes.some((item) => typeof item !== "string" || item.length > 30)
	) {
		throw new QwenIntentUnavailableError();
	}

	const result = IntentProfileSchema.safeParse({ ...raw, provider: "QWEN" });
	if (!result.success) throw new QwenIntentUnavailableError();
	return result.data;
}

@Injectable()
export class QwenIntentProvider implements IntentProvider {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(QWEN_FETCH) private readonly fetchImpl: typeof fetch,
	) {}

	async resolve(
		context: RecommendationContext,
		settings?: Pick<
			PromptSettings,
			"promptVersion" | "modelVersion" | "timeoutMs"
		>,
	): Promise<IntentProfile> {
		const { baseUrl, apiKey, enabled } = this.config.qwen;
		const promptVersion =
			settings?.promptVersion ?? this.config.versions.prompt;
		const model = settings?.modelVersion ?? this.config.qwen.model;
		const timeoutMs = settings?.timeoutMs ?? this.config.qwen.timeoutMs;
		if (!enabled || baseUrl === null || apiKey === null)
			throw new QwenIntentUnavailableError();
		const systemMessage = buildQwenSystemMessage(promptVersion);
		if (systemMessage === null || !isRegisteredQwenModel(model)) {
			throw new QwenIntentUnavailableError();
		}

		const requestBody = {
			model,
			temperature: 0.1,
			max_tokens: 500,
			enable_thinking: false,
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "intent_profile",
					strict: true,
					schema: INTENT_JSON_SCHEMA,
				},
			},
			messages: [
				systemMessage,
				{
					role: "user",
					content: JSON.stringify(qwenSafeContext(context)),
				},
			],
		};

		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const remaining = deadline - Date.now();
			if (remaining < 100) break;
			const attemptTimeout =
				attempt === 0
					? Math.min(1_700, Math.max(400, Math.floor(timeoutMs * 0.68)))
					: remaining;
			try {
				const response = await this.fetchOnce(
					`${baseUrl}/chat/completions`,
					apiKey,
					requestBody,
					attemptTimeout,
				);
				return parseQwenContent(response);
			} catch (error) {
				lastError = error;
			}
		}
		void lastError;
		throw new QwenIntentUnavailableError();
	}

	private async fetchOnce(
		endpoint: string,
		apiKey: string,
		body: object,
		timeoutMs: number,
	): Promise<unknown> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await this.fetchImpl(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) throw new QwenIntentUnavailableError();
			return await response.json();
		} catch {
			throw new QwenIntentUnavailableError();
		} finally {
			clearTimeout(timeout);
		}
	}
}
