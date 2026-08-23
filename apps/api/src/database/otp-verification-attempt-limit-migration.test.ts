import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

describe("OTP verification attempt limit migration", () => {
	it("caps the restricted transition at five attempts and preserves its privilege boundary", async () => {
		const migration = (await loadMigrationPlan())[6];
		expect(migration).toMatchObject({
			version: 7,
			name: "otp_verification_attempt_limit",
		});
		const sql = migration?.sql ?? "";
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.record_otp_verification_attempt",
		);
		expect(sql).toContain("AND attempts < 5");
		expect(sql).not.toContain("AND attempts < 10");
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.record_otp_verification_attempt",
		);
		expect(sql).toContain("FROM PUBLIC");
	});
});
