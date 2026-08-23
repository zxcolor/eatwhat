import { randomUUID } from "node:crypto";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestIds = new WeakMap<object, string>();

interface RequestIdSource {
	header?(name: string): string | undefined;
}

/** Only reflect a caller-supplied request id when it is a well-formed UUID. */
export function safeRequestId(candidate: unknown): string {
	return typeof candidate === "string" && UUID_PATTERN.test(candidate)
		? candidate
		: randomUUID();
}

/** Returns one sanitized correlation id for the complete lifetime of a request object. */
export function requestIdFor(request: object & RequestIdSource): string {
	const existing = requestIds.get(request);
	if (existing !== undefined) return existing;
	const created = safeRequestId(request.header?.("x-request-id"));
	requestIds.set(request, created);
	return created;
}
