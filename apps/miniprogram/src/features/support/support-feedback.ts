import type { PrivacyConsentAuthority } from "../consent/consent-authority";
import { isContractUuid } from "../persistence/contracts";

export type SupportFeedbackCategory =
	| "PRODUCT"
	| "PLACE_CORRECTION"
	| "PRIVACY"
	| "COMPLAINT";

export interface SupportFeedbackResponse {
	readonly feedbackId: string;
	readonly accepted: true;
	readonly retentionAfterClosureDays: 180;
}

export interface SupportFeedbackApi {
	submitSupportFeedback(
		request: {
			readonly submissionId: string;
			readonly category: SupportFeedbackCategory;
			readonly message: string;
		},
		accessToken: string | null,
	): Promise<SupportFeedbackResponse>;
}

export interface OptionalAccessToken {
	accessToken(): Promise<string | null>;
}

export type SupportFeedbackOutcome =
	| Readonly<{ ok: true; value: SupportFeedbackResponse }>
	| Readonly<{ ok: false; message: string }>;

const CATEGORIES = new Set<SupportFeedbackCategory>([
	"PRODUCT",
	"PLACE_CORRECTION",
	"PRIVACY",
	"COMPLAINT",
]);

export function normalizeFeedbackMessage(value: string): string | null {
	const normalized = value.replace(/\r\n?/gu, "\n").trim();
	const length = [...normalized].length;
	if (length < 10 || length > 2_000) return null;
	for (const character of normalized) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint <= 0x08 ||
			(codePoint >= 0x0b && codePoint <= 0x1f) ||
			(codePoint >= 0x7f && codePoint <= 0x9f)
		) {
			return null;
		}
	}
	return normalized;
}

export function parseSupportFeedbackResponse(
	value: unknown,
): SupportFeedbackResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("SUPPORT_FEEDBACK_RESPONSE_INVALID");
	}
	const source = value as Record<string, unknown>;
	if (
		Object.keys(source).sort().join(",") !==
			"accepted,feedbackId,retentionAfterClosureDays" ||
		!isContractUuid(source.feedbackId) ||
		source.accepted !== true ||
		source.retentionAfterClosureDays !== 180
	) {
		throw new Error("SUPPORT_FEEDBACK_RESPONSE_INVALID");
	}
	return Object.freeze({
		feedbackId: source.feedbackId,
		accepted: true,
		retentionAfterClosureDays: 180,
	});
}

export class SupportFeedbackService {
	constructor(
		private readonly api: SupportFeedbackApi,
		private readonly auth: OptionalAccessToken,
		private readonly consent: PrivacyConsentAuthority,
		private readonly enabled: () => boolean,
		private readonly createUuid: () => Promise<string>,
	) {}

	async submit(
		category: SupportFeedbackCategory,
		rawMessage: string,
	): Promise<SupportFeedbackOutcome> {
		if (!this.consent.isAllowed()) {
			return failed("请先阅读并同意隐私说明；本次没有发送反馈");
		}
		if (!this.enabled()) {
			return failed("反馈服务尚未完成就绪确认，当前不会提交内容");
		}
		if (!CATEGORIES.has(category)) return failed("请选择有效的反馈类型");
		const message = normalizeFeedbackMessage(rawMessage);
		if (message === null) return failed("反馈正文需为 10 到 2000 个字符");
		let submissionId: string;
		try {
			submissionId = await this.createUuid();
		} catch {
			return failed("暂时无法创建安全提交凭据，请稍后重试");
		}
		if (!isContractUuid(submissionId)) {
			return failed("暂时无法创建安全提交凭据，请稍后重试");
		}
		if (!this.consent.isAllowed() || !this.enabled()) {
			return failed("反馈服务授权已变化，本次没有提交内容");
		}
		let accessToken: string | null;
		try {
			accessToken = await this.auth.accessToken();
		} catch {
			return failed("账号状态暂时无法确认，请稍后重试；本次没有降级为游客提交");
		}
		if (!this.consent.isAllowed() || !this.enabled()) {
			return failed("反馈服务授权已变化，本次没有降级为游客提交");
		}
		try {
			return Object.freeze({
				ok: true,
				value: await this.api.submitSupportFeedback(
					{ submissionId, category, message },
					accessToken,
				),
			});
		} catch (error) {
			const status =
				typeof error === "object" && error !== null
					? (error as { readonly status?: unknown }).status
					: null;
			if (status === 429) return failed("提交过于频繁，请稍后再试");
			if (status === 503) return failed("反馈服务暂时不可用，本次内容没有保存");
			return failed("反馈提交失败，请检查网络后重试；正文不会保存到本机历史");
		}
	}
}

function failed(message: string): Readonly<{ ok: false; message: string }> {
	return Object.freeze({ ok: false, message });
}
