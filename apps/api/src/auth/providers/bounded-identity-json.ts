import { ExternalIdentityUnavailableError } from "./external-identity.provider.js";

export const IDENTITY_RESPONSE_MAX_BYTES = 64 * 1_024;

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) throw new ExternalIdentityUnavailableError("TIMEOUT");
	return await new Promise<ReadableStreamReadResult<Uint8Array>>(
		(resolve, reject) => {
			const onAbort = () =>
				reject(new ExternalIdentityUnavailableError("TIMEOUT"));
			signal.addEventListener("abort", onAbort, { once: true });
			reader
				.read()
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", onAbort));
		},
	);
}

export async function readBoundedIdentityJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	const declaredLength = response.headers.get("content-length")?.trim();
	if (declaredLength !== undefined && /^\d+$/u.test(declaredLength)) {
		const length = Number(declaredLength);
		if (!Number.isSafeInteger(length) || length > IDENTITY_RESPONSE_MAX_BYTES) {
			void response.body?.cancel().catch(() => undefined);
			throw new ExternalIdentityUnavailableError("RESPONSE_TOO_LARGE");
		}
	}
	if (response.body === null) {
		throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		let result: ReadableStreamReadResult<Uint8Array>;
		try {
			result = await readWithAbort(reader, signal);
		} catch (error) {
			void reader.cancel().catch(() => undefined);
			if (error instanceof ExternalIdentityUnavailableError) throw error;
			throw new ExternalIdentityUnavailableError(
				signal.aborted ? "TIMEOUT" : "INVALID_RESPONSE",
			);
		}
		if (result.done) break;
		total += result.value.byteLength;
		if (total > IDENTITY_RESPONSE_MAX_BYTES) {
			void reader.cancel().catch(() => undefined);
			throw new ExternalIdentityUnavailableError("RESPONSE_TOO_LARGE");
		}
		chunks.push(result.value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as unknown;
	} catch {
		throw new ExternalIdentityUnavailableError("INVALID_RESPONSE");
	}
}
