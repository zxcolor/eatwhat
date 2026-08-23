import { describe, expect, it } from "vitest";
import {
	attachAmapFailureDiagnostic,
	classifyAmapResponseStatus,
	getAmapFailureDiagnostic,
} from "./amap-response-status.js";

const classifiedCodes = [
	{
		classification: "CONFIGURATION_OR_PERMISSION",
		codes: [
			"10001",
			"10002",
			"10005",
			"10006",
			"10007",
			"10008",
			"10009",
			"10011",
			"10012",
			"10013",
			"10026",
			"10041",
			"40002",
		],
	},
	{
		classification: "QUOTA_OR_RATE_LIMIT",
		codes: [
			"10003",
			"10004",
			"10010",
			"10014",
			"10015",
			"10019",
			"10020",
			"10021",
			"10029",
			"10044",
			"10045",
			"40000",
			"40001",
			"40003",
		],
	},
	{
		classification: "REQUEST_REJECTED",
		codes: [
			"20000",
			"20001",
			"20002",
			"20011",
			"20012",
			"20800",
			"20801",
			"20802",
			"20803",
		],
	},
	{
		classification: "UPSTREAM_TRANSIENT",
		codes: ["10016", "10017", "20003"],
	},
] as const;

describe("AMap response status classifier", () => {
	it("accepts only the exact documented success pair", () => {
		expect(classifyAmapResponseStatus("1", "10000")).toEqual({
			classification: "SUCCESS",
			safeInfocode: "10000",
		});
	});

	it.each(
		classifiedCodes.flatMap(({ classification, codes }) =>
			codes.map((infocode) => ({ classification, infocode })),
		),
	)(
		"classifies $infocode as $classification",
		({ classification, infocode }) => {
			expect(classifyAmapResponseStatus("0", infocode)).toEqual({
				classification,
				safeInfocode: infocode,
			});
		},
	);

	it("normalizes the documented 300** engine family without echoing the raw code", () => {
		for (const infocode of ["30001", "32003", "39999"]) {
			expect(classifyAmapResponseStatus("0", infocode)).toEqual({
				classification: "UPSTREAM_TRANSIENT",
				safeInfocode: "3XXXX",
			});
		}
	});

	it.each([
		["1", "10001"],
		["0", "10000"],
		["2", "10001"],
		[undefined, "10001"],
		["0", undefined],
		[0, "10001"],
		["0", 10001],
		["0", "1".repeat(17)],
	])("fails closed for a malformed pair %#", (status, infocode) => {
		expect(classifyAmapResponseStatus(status, infocode)).toEqual({
			classification: "MALFORMED_RESPONSE",
			safeInfocode: "UNKNOWN",
		});
	});

	it("does not echo an unknown or hostile upstream value", () => {
		for (const infocode of ["19999", "private-key", "10005\nsecret"]) {
			const result = classifyAmapResponseStatus("0", infocode);
			expect(result).toEqual({
				classification: "UNKNOWN_REJECTION",
				safeInfocode: "UNKNOWN",
			});
			expect(JSON.stringify(result)).not.toContain(infocode);
		}
	});

	it("attaches diagnostics without exposing them through normal error serialization", () => {
		const diagnostic = classifyAmapResponseStatus("0", "10005");
		if (diagnostic.classification === "SUCCESS") {
			throw new Error("TEST_SETUP_FAILED");
		}
		const error = attachAmapFailureDiagnostic(
			new Error("safe public message"),
			diagnostic,
		);

		expect(getAmapFailureDiagnostic(error)).toEqual({
			classification: "CONFIGURATION_OR_PERMISSION",
			safeInfocode: "10005",
		});
		expect(Object.keys(error)).toEqual([]);
		expect(JSON.stringify(error)).toBe("{}");
	});
});
