import { isIP } from "node:net";
import type {
	SupportFeedbackCategory,
	SupportFeedbackRequest,
	SupportFeedbackResponse,
} from "@chi-shen-me/contracts";
import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import {
	AUTHENTICATED_USER_RESOLVER,
	type AuthenticatedUserResolver,
} from "../auth/authenticated-user.resolver.js";
import {
	SupportFeedbackQuotaExceededError,
	SupportFeedbackRepository,
} from "./support-feedback.repository.js";
import { SUPPORT_FEEDBACK_CONFIG } from "./support-feedback.tokens.js";
import type { SupportFeedbackRuntimeConfig } from "./support-feedback-config.js";
import {
	encryptSupportFeedback,
	fingerprintSupportFeedback,
	fingerprintSupportFeedbackGuestIp,
} from "./support-feedback-crypto.js";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type SubmitSupportFeedbackInput = SupportFeedbackRequest;
export type SubmitSupportFeedbackResponse = SupportFeedbackResponse;

@Injectable()
export class SupportFeedbackService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private ready = false;

	constructor(
		@Inject(SUPPORT_FEEDBACK_CONFIG)
		private readonly config: SupportFeedbackRuntimeConfig,
		private readonly repository: SupportFeedbackRepository,
		@Inject(AUTHENTICATED_USER_RESOLVER)
		private readonly authenticatedUserResolver: AuthenticatedUserResolver,
	) {}

	/**
	 * Public capability discovery may advertise feedback only after the same
	 * database/key-coverage gate used by application bootstrap has succeeded.
	 * Every pre-bootstrap, disabled, failed-bootstrap and shutdown state is
	 * deliberately reported as unavailable.
	 */
	isReady(): boolean {
		return (
			this.ready &&
			this.config.enabled &&
			this.config.encryptionKeyRing !== null &&
			this.config.hmacKeyRing !== null &&
			this.repository.isAvailable()
		);
	}

	async submit(
		input: SubmitSupportFeedbackInput,
		authorizationHeader: unknown,
		clientIp: string,
	): Promise<SubmitSupportFeedbackResponse> {
		const encryptionKeyRing = this.config.encryptionKeyRing;
		const hmacKeyRing = this.config.hmacKeyRing;
		if (
			!this.isReady() ||
			encryptionKeyRing === null ||
			hmacKeyRing === null
		) {
			throw unavailable();
		}
		const message = normalizeMessage(input.message);
		const feedbackId = input.submissionId.toLowerCase();
		if (!UUID_PATTERN.test(feedbackId)) throw invalidRequest();
		if (!isSupportFeedbackCategory(input.category)) throw invalidRequest();

		let user: Awaited<
			ReturnType<AuthenticatedUserResolver["resolveAuthorization"]>
		> | null = null;
		if (authorizationHeader !== undefined) {
			try {
				user =
					await this.authenticatedUserResolver.resolveAuthorization(
						authorizationHeader,
					);
			} catch (error) {
				if (error instanceof HttpException && error.getStatus() === 401) {
					throw error;
				}
				throw unavailable();
			}
		}
		const encrypted = encryptSupportFeedback(
			message,
			{
				feedbackId,
				category: input.category,
			},
			encryptionKeyRing,
		);
		try {
			const contentFingerprint = fingerprintSupportFeedback(
				message,
				{ feedbackId, category: input.category },
				hmacKeyRing,
			);
			let guestIpFingerprint: ReturnType<
				typeof fingerprintSupportFeedbackGuestIp
			> | null = null;
			if (user === null) {
				const normalizedClientIp = normalizeClientIp(clientIp);
				if (normalizedClientIp === null) throw unavailable();
				guestIpFingerprint = fingerprintSupportFeedbackGuestIp(
					normalizedClientIp,
					hmacKeyRing,
				);
			}
			const persisted = await this.repository.insert({
				feedbackId,
				userId: user?.userId ?? null,
				submitterKind: user === null ? "GUEST" : "ACCOUNT",
				category: input.category,
				ciphertext: encrypted.ciphertext,
				encryptionKeyVersion: encrypted.keyVersion,
				contentFingerprint: contentFingerprint.activeFingerprint,
				fingerprintKeyVersion: contentFingerprint.activeKeyVersion,
				contentFingerprintCandidates: contentFingerprint.candidates,
				guestIpHash: guestIpFingerprint?.activeFingerprint ?? null,
				guestIpHashKeyVersion: guestIpFingerprint?.activeKeyVersion ?? null,
				guestIpHashCandidates: guestIpFingerprint?.candidates ?? null,
			});
			if (persisted.kind === "MISMATCH") throw conflict();
		} catch (error) {
			if (error instanceof HttpException) throw error;
			if (error instanceof SupportFeedbackQuotaExceededError) {
				throw quotaExceeded();
			}
			throw unavailable();
		} finally {
			encrypted.ciphertext.fill(0);
		}

		return Object.freeze({
			feedbackId,
			accepted: true as const,
			retentionAfterClosureDays: 180 as const,
		});
	}

	async onApplicationBootstrap(): Promise<void> {
		this.ready = false;
		if (!this.config.enabled) return;
		const encryptionKeyRing = this.config.encryptionKeyRing;
		const hmacKeyRing = this.config.hmacKeyRing;
		if (
			encryptionKeyRing === null ||
			hmacKeyRing === null ||
			!this.repository.isAvailable()
		) {
			encryptionKeyRing?.destroy();
			hmacKeyRing?.destroy();
			throw new Error("反馈服务密钥覆盖检查不可用");
		}
		try {
			const required = await this.repository.requiredKeyVersions();
			for (const entry of required) {
				if (!Number.isSafeInteger(entry.recordCount) || entry.recordCount < 1) {
					throw new Error("反馈服务密钥覆盖检查返回无效结果");
				}
				if (entry.purpose === "LEGACY") {
					throw new Error("反馈服务存在待离线迁移的旧版记录");
				}
				if (
					entry.keyVersion === null ||
					(entry.purpose === "ENCRYPTION"
						? encryptionKeyRing.versions().includes(entry.keyVersion)
						: hmacKeyRing.versions().includes(entry.keyVersion)) === false
				) {
					throw new Error(
						`反馈服务缺少数据库所需的 ${entry.purpose} 密钥版本 ${entry.keyVersion ?? "UNKNOWN"}`,
					);
				}
			}
			this.ready = true;
		} catch (error) {
			this.ready = false;
			encryptionKeyRing.destroy();
			hmacKeyRing.destroy();
			throw error;
		}
	}

	onApplicationShutdown(): void {
		this.ready = false;
		this.config.encryptionKeyRing?.destroy();
		this.config.hmacKeyRing?.destroy();
	}
}

export function normalizeMessage(value: unknown): string {
	if (typeof value !== "string") throw invalidRequest();
	const normalized = value.replace(/\r\n?/gu, "\n").trim();
	const codePointLength = Array.from(normalized).length;
	if (codePointLength < 10 || codePointLength > 2_000) {
		throw invalidRequest();
	}
	for (const character of normalized) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint <= 0x08 ||
			(codePoint >= 0x0b && codePoint <= 0x1f) ||
			(codePoint >= 0x7f && codePoint <= 0x9f)
		) {
			throw invalidRequest();
		}
	}
	return normalized;
}

function isSupportFeedbackCategory(
	value: unknown,
): value is SupportFeedbackCategory {
	return (
		value === "PRODUCT" ||
		value === "PLACE_CORRECTION" ||
		value === "PRIVACY" ||
		value === "COMPLAINT"
	);
}

function invalidRequest(): HttpException {
	return new HttpException(
		{ code: "INVALID_REQUEST", message: "反馈内容不符合提交要求" },
		HttpStatus.BAD_REQUEST,
	);
}

function unavailable(): HttpException {
	return new HttpException(
		{
			code: "SUPPORT_FEEDBACK_UNAVAILABLE",
			message: "反馈服务暂时不可用，请稍后重试",
		},
		HttpStatus.SERVICE_UNAVAILABLE,
	);
}

function conflict(): HttpException {
	return new HttpException(
		{
			code: "SUPPORT_FEEDBACK_IDEMPOTENCY_CONFLICT",
			message: "反馈提交标识已被其他内容使用，请重新提交",
		},
		HttpStatus.CONFLICT,
	);
}

function quotaExceeded(): HttpException {
	return new HttpException(
		{
			code: "SUPPORT_FEEDBACK_RATE_LIMITED",
			message: "反馈提交过于频繁，请稍后再试",
		},
		HttpStatus.TOO_MANY_REQUESTS,
	);
}

export function normalizeClientIp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const candidate = value.trim().toLowerCase();
	if (candidate.length < 1 || candidate.length > 64) return null;
	if (candidate.startsWith("::ffff:")) {
		const ipv4 = candidate.slice("::ffff:".length);
		if (isIP(ipv4) === 4) return ipv4;
	}
	const family = isIP(candidate);
	if (family === 4) return candidate;
	if (family !== 6) return null;
	return canonicalizeIpv6(candidate);
}

function canonicalizeIpv6(value: string): string | null {
	let address = value;
	if (address.includes(".")) {
		const separator = address.lastIndexOf(":");
		const ipv4 = address.slice(separator + 1);
		const octets = ipv4.split(".").map(Number);
		if (
			separator < 0 ||
			octets.length !== 4 ||
			octets.some(
				(octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
			)
		) {
			return null;
		}
		address = `${address.slice(0, separator + 1)}${(
			((octets[0] as number) << 8) | (octets[1] as number)
		).toString(16)}:${(
			((octets[2] as number) << 8) | (octets[3] as number)
		).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
	const tail =
		halves.length === 1 || halves[1] === ""
			? []
			: (halves[1]?.split(":") ?? []);
	const missing = 8 - head.length - tail.length;
	if (
		(halves.length === 1 && missing !== 0) ||
		(halves.length === 2 && missing < 1)
	) {
		return null;
	}
	const segments = [
		...head.map((segment) => Number.parseInt(segment, 16)),
		...Array.from({ length: missing }, () => 0),
		...tail.map((segment) => Number.parseInt(segment, 16)),
	];
	if (
		segments.length !== 8 ||
		segments.some(
			(segment) =>
				!Number.isInteger(segment) || segment < 0 || segment > 0xffff,
		)
	) {
		return null;
	}
	if (
		segments.slice(0, 5).every((segment) => segment === 0) &&
		segments[5] === 0xffff
	) {
		return [
			(segments[6] as number) >> 8,
			(segments[6] as number) & 0xff,
			(segments[7] as number) >> 8,
			(segments[7] as number) & 0xff,
		].join(".");
	}

	let bestStart = -1;
	let bestLength = 0;
	for (let index = 0; index < segments.length; ) {
		if (segments[index] !== 0) {
			index += 1;
			continue;
		}
		let end = index;
		while (segments[end] === 0) end += 1;
		if (end - index > bestLength) {
			bestStart = index;
			bestLength = end - index;
		}
		index = end;
	}
	const encoded = segments.map((segment) => segment.toString(16));
	if (bestLength < 2) return encoded.join(":");
	const left = encoded.slice(0, bestStart).join(":");
	const right = encoded.slice(bestStart + bestLength).join(":");
	return `${left}::${right}`;
}
