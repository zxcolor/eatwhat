import { describe, expect, it, vi } from "vitest";
import { requestIdFor, safeRequestId } from "./safe-request-id.js";

describe("request id correlation", () => {
	it("preserves a valid caller UUID", () => {
		const value = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
		expect(safeRequestId(value)).toBe(value);
	});

	it("creates one value per request object when the header is absent", () => {
		const request = { header: vi.fn().mockReturnValue(undefined) };
		const first = requestIdFor(request);
		const second = requestIdFor(request);

		expect(second).toBe(first);
		expect(first).toMatch(/^[0-9a-f-]{36}$/iu);
		expect(request.header).toHaveBeenCalledTimes(1);
	});

	it("does not share generated ids between requests", () => {
		const first = requestIdFor({});
		const second = requestIdFor({});
		expect(second).not.toBe(first);
	});
});
