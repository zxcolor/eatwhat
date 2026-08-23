import { AuthUnauthorizedException } from "./auth-errors.js";

const BEARER_ACCESS_TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/iu;

/** Extracts only an App-owned opaque token and never includes the raw header in errors. */
export function requireBearerAccessToken(value: unknown): string {
	if (typeof value !== "string") throw new AuthUnauthorizedException();
	const match = BEARER_ACCESS_TOKEN.exec(value);
	if (match?.[1] === undefined) throw new AuthUnauthorizedException();
	return match[1];
}

export function optionalBearerAccessToken(value: unknown): string | null {
	if (value === undefined) return null;
	return requireBearerAccessToken(value);
}
