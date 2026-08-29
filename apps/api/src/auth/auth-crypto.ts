import {
	type Argon2Parameters,
	argon2,
	createHmac,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OTP_HASH_PATTERN =
	/^a2id\$v=1\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/u;

export interface VersionedHash {
	readonly value: string;
	readonly keyVersion: string;
}

export interface IssuedOpaqueToken {
	readonly token: string;
	readonly hash: VersionedHash;
}

export interface OtpHashParameters {
	readonly memoryKiB: number;
	readonly passes: number;
	readonly parallelism: number;
}

export const DEFAULT_OTP_HASH_PARAMETERS: OtpHashParameters = Object.freeze({
	memoryKiB: 19_456,
	passes: 2,
	parallelism: 2,
});

/**
 * A small immutable key ring. Key bytes are copied on input and output is never
 * exposed, so callers cannot mutate or log the configured secret by accident.
 */
export class AuthSecretKeyRing {
	readonly activeVersion: string;
	readonly #keys: ReadonlyMap<string, Buffer>;

	constructor(activeVersion: string, keys: ReadonlyMap<string, Uint8Array>) {
		if (!KEY_VERSION_PATTERN.test(activeVersion)) {
			throw new Error("认证密钥版本格式无效");
		}
		if (keys.size === 0 || !keys.has(activeVersion)) {
			throw new Error("认证密钥环必须包含当前版本");
		}

		const copied = new Map<string, Buffer>();
		for (const [version, key] of keys) {
			if (!KEY_VERSION_PATTERN.test(version)) {
				throw new Error("认证密钥版本格式无效");
			}
			if (key.byteLength < 32 || key.byteLength > 128) {
				throw new Error("认证密钥长度必须为 32 到 128 字节");
			}
			copied.set(version, Buffer.from(key));
		}
		this.activeVersion = activeVersion;
		this.#keys = copied;
	}

	activeKey(): Buffer {
		return Buffer.from(this.#keys.get(this.activeVersion) as Buffer);
	}

	key(version: string): Buffer | null {
		const key = this.#keys.get(version);
		return key === undefined ? null : Buffer.from(key);
	}

	/**
	 * Returns only bounded, non-secret version labels. Token lookup must hash
	 * against the configured current and retiring versions; it must never derive
	 * an unbounded key list from database rows.
	 */
	versions(): readonly string[] {
		return Object.freeze([...this.#keys.keys()]);
	}
}

export function issueOpaqueToken(
	keyRing: AuthSecretKeyRing,
	domain: "access-token" | "refresh-token",
): IssuedOpaqueToken {
	const token = randomBytes(32).toString("base64url");
	return Object.freeze({
		token,
		hash: hashOpaqueToken(token, keyRing, domain),
	});
}

export function hashOpaqueToken(
	token: string,
	keyRing: AuthSecretKeyRing,
	domain: "access-token" | "refresh-token",
	keyVersion = keyRing.activeVersion,
): VersionedHash {
	if (!BASE64URL_32_BYTES.test(token)) {
		throw new Error("认证令牌格式无效");
	}
	return hmacValue(keyRing, keyVersion, domain, token);
}

export function hashIdentityLookup(
	provider: "PHONE" | "WECHAT" | "EMAIL" | "QQ" | "APPLE",
	providerScope: string,
	normalizedSubject: string,
	keyRing: AuthSecretKeyRing,
	keyVersion = keyRing.activeVersion,
): VersionedHash {
	if (providerScope.length < 1 || providerScope.length > 160) {
		throw new Error("身份作用域格式无效");
	}
	if (normalizedSubject.length < 1 || normalizedSubject.length > 512) {
		throw new Error("身份标识格式无效");
	}
	return hmacValue(
		keyRing,
		keyVersion,
		"identity-lookup",
		`${provider}\u0000${providerScope}\u0000${normalizedSubject}`,
	);
}

export function hashAccountDeletionSubject(
	userId: string,
	keyRing: AuthSecretKeyRing,
	keyVersion = keyRing.activeVersion,
): VersionedHash {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
			userId,
		)
	) {
		throw new Error("账号标识格式无效");
	}
	return hmacValue(keyRing, keyVersion, "account-deletion-subject", userId);
}

export function hashSensitiveRateLimitValue(
	domain:
		| "destination"
		| "device"
		| "ip"
		| "idempotency"
		| "oauth-state"
		| "flow-reference",
	value: string,
	keyRing: AuthSecretKeyRing,
	keyVersion = keyRing.activeVersion,
): VersionedHash {
	if (value.length < 1 || value.length > 2_048) {
		throw new Error("认证限流值格式无效");
	}
	return hmacValue(keyRing, keyVersion, `rate-limit:${domain}`, value);
}

export function generateSixDigitOtp(): string {
	return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function generateOAuthState(): string {
	return randomBytes(32).toString("base64url");
}

export async function hashOtpCode(
	code: string,
	pepperRing: AuthSecretKeyRing,
	parameters: OtpHashParameters = DEFAULT_OTP_HASH_PARAMETERS,
): Promise<VersionedHash> {
	assertOtpCode(code);
	assertOtpParameters(parameters);
	const salt = randomBytes(16);
	const pepper = pepperRing.activeKey();
	try {
		const derived = await deriveOtpKey(code, salt, pepper, parameters);
		return Object.freeze({
			value:
				`a2id$v=1$m=${parameters.memoryKiB},t=${parameters.passes},` +
				`p=${parameters.parallelism}$${salt.toString("base64url")}$${derived.toString("base64url")}`,
			keyVersion: pepperRing.activeVersion,
		});
	} finally {
		pepper.fill(0);
	}
}

export async function verifyOtpCode(
	code: string,
	encodedHash: string,
	keyVersion: string,
	pepperRing: AuthSecretKeyRing,
): Promise<boolean> {
	if (!/^\d{6}$/u.test(code)) return false;
	const match = OTP_HASH_PATTERN.exec(encodedHash);
	if (match === null) return false;
	const pepper = pepperRing.key(keyVersion);
	if (pepper === null) return false;

	const parameters = Object.freeze({
		memoryKiB: Number(match[1]),
		passes: Number(match[2]),
		parallelism: Number(match[3]),
	});
	try {
		assertOtpParameters(parameters);
		const salt = Buffer.from(match[4] as string, "base64url");
		const expected = Buffer.from(match[5] as string, "base64url");
		if (salt.length !== 16 || expected.length !== 32) return false;
		const actual = await deriveOtpKey(code, salt, pepper, parameters);
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	} finally {
		pepper.fill(0);
	}
}

export function constantTimeHashEquals(left: string, right: string): boolean {
	if (!HEX_SHA256_PATTERN.test(left) || !HEX_SHA256_PATTERN.test(right)) {
		return false;
	}
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function hmacValue(
	keyRing: AuthSecretKeyRing,
	keyVersion: string,
	domain: string,
	value: string,
): VersionedHash {
	const key = keyRing.key(keyVersion);
	if (key === null) throw new Error("认证密钥版本不可用");
	try {
		const digest = createHmac("sha256", key)
			.update("chi-shen-me:auth:v1\u0000", "utf8")
			.update(domain, "utf8")
			.update("\u0000", "utf8")
			.update(value, "utf8")
			.digest("hex");
		return Object.freeze({ value: digest, keyVersion });
	} finally {
		key.fill(0);
	}
}

function assertOtpCode(code: string): void {
	if (!/^\d{6}$/u.test(code)) throw new Error("验证码格式无效");
}

function assertOtpParameters(parameters: OtpHashParameters): void {
	if (
		!Number.isInteger(parameters.memoryKiB) ||
		parameters.memoryKiB < 1_024 ||
		parameters.memoryKiB > 65_536 ||
		!Number.isInteger(parameters.passes) ||
		parameters.passes < 2 ||
		parameters.passes > 5 ||
		!Number.isInteger(parameters.parallelism) ||
		parameters.parallelism < 1 ||
		parameters.parallelism > 4 ||
		parameters.memoryKiB < 8 * parameters.parallelism
	) {
		throw new Error("Argon2id 参数不在允许范围内");
	}
}

function deriveOtpKey(
	code: string,
	salt: Buffer,
	pepper: Buffer,
	parameters: OtpHashParameters,
): Promise<Buffer> {
	const options: Argon2Parameters = {
		message: Buffer.from(code, "utf8"),
		nonce: salt,
		parallelism: parameters.parallelism,
		tagLength: 32,
		memory: parameters.memoryKiB,
		passes: parameters.passes,
		secret: pepper,
		associatedData: Buffer.from("chi-shen-me:otp:v1", "utf8"),
	};
	return new Promise((resolve, reject) => {
		argon2("argon2id", options, (error, derivedKey) => {
			if (error !== null) reject(error);
			else resolve(Buffer.from(derivedKey));
		});
	});
}
