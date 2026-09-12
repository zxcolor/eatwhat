export type BoundedJsonFailureReason =
	| "TIMEOUT"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_RESPONSE";

/** Only a fixed reason crosses the provider boundary; never attach body/error text. */
export class BoundedJsonResponseError extends Error {
	constructor(readonly reason: BoundedJsonFailureReason) {
		super("Upstream JSON response unavailable");
		this.name = "BoundedJsonResponseError";
	}
}

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) throw new BoundedJsonResponseError("TIMEOUT");
	return await new Promise<ReadableStreamReadResult<Uint8Array>>(
		(resolve, reject) => {
			const onAbort = () => reject(new BoundedJsonResponseError("TIMEOUT"));
			signal.addEventListener("abort", onAbort, { once: true });
			reader
				.read()
				.then(resolve, reject)
				.finally(() => {
					signal.removeEventListener("abort", onAbort);
				});
		},
	);
}

/** Bounds actual decoded response bytes, regardless of missing or misleading headers. */
export async function readBoundedJson(
	response: Response,
	signal: AbortSignal,
	maximumBytes: number,
): Promise<unknown> {
	const cancelBody = () => {
		void response.body?.cancel().catch(() => undefined);
	};
	if (signal.aborted) {
		cancelBody();
		throw new BoundedJsonResponseError("TIMEOUT");
	}
	const declaredLength = response.headers.get("content-length")?.trim();
	if (declaredLength !== undefined && /^\d+$/.test(declaredLength)) {
		const parsedLength = Number(declaredLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
			cancelBody();
			throw new BoundedJsonResponseError("RESPONSE_TOO_LARGE");
		}
	}
	if (response.body === null)
		throw new BoundedJsonResponseError("INVALID_RESPONSE");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const result = await readWithAbort(reader, signal);
			if (signal.aborted) throw new BoundedJsonResponseError("TIMEOUT");
			if (result.done) break;
			totalBytes += result.value.byteLength;
			if (totalBytes > maximumBytes)
				throw new BoundedJsonResponseError("RESPONSE_TOO_LARGE");
			chunks.push(result.value);
		}
		const bytes = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as unknown;
	} catch (error) {
		// Do not await upstream cancellation: a broken stream may never settle it.
		void reader.cancel().catch(() => undefined);
		if (error instanceof BoundedJsonResponseError) throw error;
		throw new BoundedJsonResponseError(
			signal.aborted ? "TIMEOUT" : "INVALID_RESPONSE",
		);
	} finally {
		reader.releaseLock();
	}
}
