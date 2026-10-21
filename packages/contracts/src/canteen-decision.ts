import { z } from "zod";

export const CANTEEN_MIMO_CONSENT_VERSION = "canteen-mimo-v1" as const;
export const CANTEEN_MIMO_MODELS = [
	"mimo-v2.6-flash",
	"mimo-v2.6-pro",
] as const;
export const CanteenItemIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u);
export const CanteenTasteSchema = z
	.object({
		spicyLevel: z.number().int().min(0).max(6),
		flavorIntensity: z.number().int().min(0).max(100),
	})
	.strict();
export const CanteenDecisionRequestSchema = z
	.object({
		requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/u),
		menuVersion: z.string().regex(/^canteen-menu-v[1-9][0-9]*$/u),
		preferenceRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		consentVersion: z.literal(CANTEEN_MIMO_CONSENT_VERSION),
		preferences: CanteenTasteSchema,
		excludedItemIds: z
			.array(CanteenItemIdSchema)
			.max(200)
			.refine(
				(ids) => new Set(ids).size === ids.length,
				"Duplicate excluded item",
			),
	})
	.strict();
export type CanteenDecisionRequest = z.infer<
	typeof CanteenDecisionRequestSchema
>;

export const CanteenFallbackReasonSchema = z.enum([
	"DISABLED",
	"UNAVAILABLE",
	"CAPACITY",
	"INVALID_MODEL_RESULT",
	"SINGLE_CANDIDATE",
	"NO_CANDIDATES",
]);
export const CanteenDecisionResponseSchema = z
	.object({
		requestId: z.string(),
		menuVersion: z.string(),
		preferenceRevision: z.number().int().min(1),
		status: z.enum(["SELECTED", "EXHAUSTED"]),
		selectedItemId: CanteenItemIdSchema.nullable(),
		source: z.enum(["MIMO", "LOCAL"]),
		model: z.enum(CANTEEN_MIMO_MODELS).nullable(),
		fallbackReason: CanteenFallbackReasonSchema.nullable(),
		notice: z.literal("TASTE_ATTRIBUTES_UNVERIFIED"),
	})
	.strict()
	.refine(
		(value) =>
			(value.status === "SELECTED") === (value.selectedItemId !== null) &&
			(value.status === "EXHAUSTED"
				? value.source === "LOCAL" && value.fallbackReason === "NO_CANDIDATES"
				: value.fallbackReason !== "NO_CANDIDATES") &&
			(value.source === "MIMO"
				? value.model !== null && value.fallbackReason === null
				: value.model === null && value.fallbackReason !== null),
		"Inconsistent decision provenance",
	);
export type CanteenDecisionResponse = z.infer<
	typeof CanteenDecisionResponseSchema
>;
