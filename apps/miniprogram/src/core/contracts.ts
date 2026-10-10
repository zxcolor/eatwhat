export const CONTRACT_VERSION_HEADER = "X-ChiShenMe-Contract-Version";
export const CONTRACT_VERSION = "1";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const OAUTH_CODE_PATTERN = /^[A-Za-z0-9._~+/=-]{8,2048}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,189}$/u;

export type SupportedIdentityType = "PHONE" | "WECHAT" | "EMAIL" | "QQ";
export type PhonePurpose = "REGISTER" | "LOGIN";
export type EmailPurpose = "LOGIN" | "BIND";

export interface OtpChallengeResponse {
	readonly challengeId: string;
	readonly targetType: "PHONE" | "EMAIL";
	readonly maskedTarget: string;
	readonly expiresAt: string;
	readonly resendAvailableAt: string;
}

export interface OAuthStateResponse {
	readonly provider: "WECHAT";
	readonly purpose: "LOGIN" | "BIND";
	readonly state: string;
	readonly expiresAt: string;
}

export interface AuthTokenResponse {
	readonly userId: string;
	readonly sessionId: string;
	readonly tokenType: "Bearer";
	readonly accessToken: string;
	readonly accessTokenExpiresAt: string;
	readonly refreshToken: string;
	readonly refreshTokenExpiresAt: string;
}

export interface IdentityBinding {
	readonly bindingId: string;
	readonly type: SupportedIdentityType;
	readonly maskedValue: string;
	readonly boundAt: string;
	readonly primary: boolean;
	readonly canUnbind: boolean;
}

export interface IdentityBindingsResponse {
	readonly items: readonly IdentityBinding[];
}

export interface BindIdentityResponse {
	readonly binding: IdentityBinding;
}

export interface SessionSummary {
	readonly sessionId: string;
	readonly deviceLabel: string;
	readonly platform: "ANDROID" | "MINIPROGRAM";
	readonly current: boolean;
	readonly createdAt: string;
	readonly lastActiveAt: string;
	readonly expiresAt: string;
}

export interface SessionsResponse {
	readonly items: readonly SessionSummary[];
}

interface AccountExportStatusBase {
	readonly exportId: string;
	readonly requestedAt: string;
	readonly expiresAt: string;
	readonly includeBehaviorHistory: boolean;
}

export type AccountExportStatus =
	| (AccountExportStatusBase & {
			readonly status: "QUEUED" | "PROCESSING";
			readonly downloadAvailable: false;
	  })
	| (AccountExportStatusBase & {
			readonly status: "READY";
			readonly readyAt: string;
			readonly sizeBytes: number;
			readonly sha256: string;
			readonly contentType: "application/json";
			readonly downloadAvailable: true;
	  })
	| (AccountExportStatusBase & {
			readonly status: "FAILED";
			readonly failureCode: "GENERATION_FAILED";
			readonly downloadAvailable: false;
	  })
	| (AccountExportStatusBase & {
			readonly status: "EXPIRED";
			readonly downloadAvailable: false;
	  });

export interface AccountExportReceipt {
	readonly exportId: string;
	readonly status: "QUEUED";
	readonly requestedAt: string;
	readonly expiresAt: string;
	readonly includeBehaviorHistory: boolean;
}

export interface LatestAccountExportResponse {
	readonly item: AccountExportStatus | null;
}

export interface DeleteAccountResponse {
	readonly deletionId: string;
	readonly userId: string;
	readonly status: "DEACTIVATED";
	readonly invalidatedAt: string;
	readonly backupDeletionDeadline: string;
}

export function objectValue(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return value as Record<string, unknown>;
}

export function exactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
}

function stringValue(
	value: unknown,
	pattern?: RegExp,
	maximum = 2_048,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		(pattern !== undefined && !pattern.test(value))
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return value;
}

export function isoDateTime(value: unknown): string {
	const text = stringValue(value, undefined, 64);
	if (!ISO_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return text;
}

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isToken(value: unknown): value is string {
	return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function isWechatLoginCode(value: unknown): value is string {
	return typeof value === "string" && OAUTH_CODE_PATTERN.test(value);
}

export function isMainlandPhone(value: unknown): value is string {
	return typeof value === "string" && /^\+861[3-9]\d{9}$/u.test(value);
}

export function isEmailAddress(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 254 &&
		EMAIL_PATTERN.test(value)
	);
}

export function isOtpCode(value: unknown): value is string {
	return typeof value === "string" && /^\d{6}$/u.test(value);
}

export function parsePhoneChallengeResponse(
	value: unknown,
): OtpChallengeResponse {
	return parseChallenge(value, "PHONE", /^\+861\d{2}\*{4}\d{4}$/u);
}

export function parseEmailChallengeResponse(
	value: unknown,
): OtpChallengeResponse {
	return parseChallenge(
		value,
		"EMAIL",
		/^[^@\s]*\*+[^@\s]*@[A-Za-z0-9.-]{1,190}$/u,
	);
}

function parseChallenge(
	value: unknown,
	targetType: "PHONE" | "EMAIL",
	maskedPattern: RegExp,
): OtpChallengeResponse {
	const body = objectValue(value);
	exactKeys(body, [
		"challengeId",
		"targetType",
		"maskedTarget",
		"expiresAt",
		"resendAvailableAt",
	]);
	if (!isUuid(body.challengeId) || body.targetType !== targetType) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return Object.freeze({
		challengeId: body.challengeId,
		targetType,
		maskedTarget: stringValue(body.maskedTarget, maskedPattern, 254),
		expiresAt: isoDateTime(body.expiresAt),
		resendAvailableAt: isoDateTime(body.resendAvailableAt),
	});
}

export function parseOAuthStateResponse(value: unknown): OAuthStateResponse {
	const body = objectValue(value);
	exactKeys(body, ["provider", "purpose", "state", "expiresAt"]);
	if (
		body.provider !== "WECHAT" ||
		(body.purpose !== "LOGIN" && body.purpose !== "BIND")
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return Object.freeze({
		provider: "WECHAT",
		purpose: body.purpose,
		state: stringValue(body.state, TOKEN_PATTERN),
		expiresAt: isoDateTime(body.expiresAt),
	});
}

export function parseAuthTokenResponse(value: unknown): AuthTokenResponse {
	const body = objectValue(value);
	exactKeys(body, [
		"userId",
		"sessionId",
		"tokenType",
		"accessToken",
		"accessTokenExpiresAt",
		"refreshToken",
		"refreshTokenExpiresAt",
	]);
	if (
		!isUuid(body.userId) ||
		!isUuid(body.sessionId) ||
		body.tokenType !== "Bearer"
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return Object.freeze({
		userId: body.userId,
		sessionId: body.sessionId,
		tokenType: "Bearer",
		accessToken: stringValue(body.accessToken, TOKEN_PATTERN),
		accessTokenExpiresAt: isoDateTime(body.accessTokenExpiresAt),
		refreshToken: stringValue(body.refreshToken, TOKEN_PATTERN),
		refreshTokenExpiresAt: isoDateTime(body.refreshTokenExpiresAt),
	});
}

function parseIdentityBinding(value: unknown): IdentityBinding | null {
	const binding = objectValue(value);
	exactKeys(binding, [
		"bindingId",
		"type",
		"maskedValue",
		"boundAt",
		"primary",
		"canUnbind",
	]);
	if (
		!isUuid(binding.bindingId) ||
		typeof binding.type !== "string" ||
		!/^[A-Z][A-Z0-9_]{1,31}$/u.test(binding.type) ||
		typeof binding.primary !== "boolean" ||
		typeof binding.canUnbind !== "boolean"
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	const maskedValue = stringValue(binding.maskedValue, undefined, 254);
	const boundAt = isoDateTime(binding.boundAt);
	if (!["PHONE", "WECHAT", "EMAIL", "QQ"].includes(binding.type)) return null;
	const type = binding.type as SupportedIdentityType;
	if (
		(type === "WECHAT" && maskedValue !== "微信账号") ||
		(type === "QQ" && maskedValue !== "QQ 账号") ||
		(type === "PHONE" && !/^\+861\d{2}\*{4}\d{4}$/u.test(maskedValue)) ||
		(type === "EMAIL" &&
			!/^[^@\s]*\*+[^@\s]*@[A-Za-z0-9.-]{1,190}$/u.test(maskedValue))
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return Object.freeze({
		bindingId: binding.bindingId,
		type,
		maskedValue,
		boundAt,
		primary: binding.primary,
		canUnbind: binding.canUnbind,
	});
}

export function parseIdentityBindingsResponse(
	value: unknown,
): IdentityBindingsResponse {
	const body = objectValue(value);
	exactKeys(body, ["items"]);
	if (!Array.isArray(body.items) || body.items.length > 8) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	const items = body.items
		.map(parseIdentityBinding)
		.filter((item): item is IdentityBinding => item !== null);
	return Object.freeze({ items: Object.freeze(items) });
}

export function parseBindIdentityResponse(
	value: unknown,
): BindIdentityResponse {
	const body = objectValue(value);
	exactKeys(body, ["binding"]);
	const binding = parseIdentityBinding(body.binding);
	if (binding === null) throw new Error("CONTRACT_RESPONSE_INVALID");
	return Object.freeze({ binding });
}

export function parseSessionsResponse(value: unknown): SessionsResponse {
	const body = objectValue(value);
	exactKeys(body, ["items"]);
	if (!Array.isArray(body.items) || body.items.length > 50) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return Object.freeze({
		items: Object.freeze(body.items.map(parseSessionSummary)),
	});
}

function parseSessionSummary(value: unknown): SessionSummary {
	const session = objectValue(value);
	exactKeys(session, [
		"sessionId",
		"deviceLabel",
		"platform",
		"current",
		"createdAt",
		"lastActiveAt",
		"expiresAt",
	]);
	if (
		!isUuid(session.sessionId) ||
		(session.platform !== "ANDROID" && session.platform !== "MINIPROGRAM") ||
		typeof session.current !== "boolean"
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	const deviceLabel = stringValue(session.deviceLabel, undefined, 80).trim();
	if (deviceLabel.length === 0) throw new Error("CONTRACT_RESPONSE_INVALID");
	return Object.freeze({
		sessionId: session.sessionId,
		deviceLabel,
		platform: session.platform,
		current: session.current,
		createdAt: isoDateTime(session.createdAt),
		lastActiveAt: isoDateTime(session.lastActiveAt),
		expiresAt: isoDateTime(session.expiresAt),
	});
}

export function parseAccountExportReceipt(
	value: unknown,
): AccountExportReceipt {
	const body = objectValue(value);
	exactKeys(body, [
		"exportId",
		"status",
		"requestedAt",
		"expiresAt",
		"includeBehaviorHistory",
	]);
	if (
		!isUuid(body.exportId) ||
		body.status !== "QUEUED" ||
		typeof body.includeBehaviorHistory !== "boolean"
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return Object.freeze({
		exportId: body.exportId,
		status: "QUEUED",
		requestedAt: isoDateTime(body.requestedAt),
		expiresAt: isoDateTime(body.expiresAt),
		includeBehaviorHistory: body.includeBehaviorHistory,
	});
}

function parseExportStatus(value: unknown): AccountExportStatus {
	const body = objectValue(value);
	const status = body.status;
	const baseKeys = [
		"exportId",
		"status",
		"requestedAt",
		"expiresAt",
		"includeBehaviorHistory",
		"downloadAvailable",
	];
	if (
		!isUuid(body.exportId) ||
		typeof body.includeBehaviorHistory !== "boolean"
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	const base = {
		exportId: body.exportId,
		requestedAt: isoDateTime(body.requestedAt),
		expiresAt: isoDateTime(body.expiresAt),
		includeBehaviorHistory: body.includeBehaviorHistory,
	};
	if (status === "QUEUED" || status === "PROCESSING") {
		exactKeys(body, baseKeys);
		if (body.downloadAvailable !== false)
			throw new Error("CONTRACT_RESPONSE_INVALID");
		return Object.freeze({ ...base, status, downloadAvailable: false });
	}
	if (status === "READY") {
		exactKeys(body, [
			...baseKeys,
			"readyAt",
			"sizeBytes",
			"sha256",
			"contentType",
		]);
		if (
			body.downloadAvailable !== true ||
			!Number.isSafeInteger(body.sizeBytes) ||
			(body.sizeBytes as number) < 0 ||
			(body.sizeBytes as number) > 10_485_760 ||
			typeof body.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/u.test(body.sha256) ||
			body.contentType !== "application/json"
		) {
			throw new Error("CONTRACT_RESPONSE_INVALID");
		}
		return Object.freeze({
			...base,
			status,
			readyAt: isoDateTime(body.readyAt),
			sizeBytes: body.sizeBytes as number,
			sha256: body.sha256,
			contentType: "application/json",
			downloadAvailable: true,
		});
	}
	if (status === "FAILED") {
		exactKeys(body, [...baseKeys, "failureCode"]);
		if (
			body.downloadAvailable !== false ||
			body.failureCode !== "GENERATION_FAILED"
		) {
			throw new Error("CONTRACT_RESPONSE_INVALID");
		}
		return Object.freeze({
			...base,
			status,
			failureCode: "GENERATION_FAILED",
			downloadAvailable: false,
		});
	}
	if (status === "EXPIRED") {
		exactKeys(body, baseKeys);
		if (body.downloadAvailable !== false)
			throw new Error("CONTRACT_RESPONSE_INVALID");
		return Object.freeze({ ...base, status, downloadAvailable: false });
	}
	throw new Error("CONTRACT_RESPONSE_INVALID");
}

export function parseLatestAccountExportResponse(
	value: unknown,
): LatestAccountExportResponse {
	const body = objectValue(value);
	exactKeys(body, ["item"]);
	return Object.freeze({
		item: body.item === null ? null : parseExportStatus(body.item),
	});
}

export function parseAccountExportStatus(value: unknown): AccountExportStatus {
	return parseExportStatus(value);
}

export function parseDeleteAccountResponse(
	value: unknown,
): DeleteAccountResponse {
	const body = objectValue(value);
	exactKeys(body, [
		"deletionId",
		"userId",
		"status",
		"invalidatedAt",
		"backupDeletionDeadline",
	]);
	if (
		!isUuid(body.deletionId) ||
		!isUuid(body.userId) ||
		body.status !== "DEACTIVATED"
	) {
		throw new Error("CONTRACT_RESPONSE_INVALID");
	}
	return Object.freeze({
		deletionId: body.deletionId,
		userId: body.userId,
		status: "DEACTIVATED",
		invalidatedAt: isoDateTime(body.invalidatedAt),
		backupDeletionDeadline: isoDateTime(body.backupDeletionDeadline),
	});
}

export function parseMutationAcknowledgement(
	value: unknown,
	idKey: string,
	timeKey: string,
): void {
	const body = objectValue(value);
	exactKeys(body, [idKey, timeKey]);
	if (!isUuid(body[idKey])) throw new Error("CONTRACT_RESPONSE_INVALID");
	isoDateTime(body[timeKey]);
}
