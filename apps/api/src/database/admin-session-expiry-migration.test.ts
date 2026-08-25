import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

describe("administrator session expiry qualification migration", () => {
	it("replaces the session authenticator without changing its contract", async () => {
		const migration = (await loadMigrationPlan())[8];
		expect(migration).toMatchObject({
			version: 9,
			name: "qualify_admin_session_expiry",
		});
		const sql = migration?.sql ?? "";
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.admin_authenticate_session",
		);
		expect(sql).toContain("RETURNS TABLE(");
		expect(sql).toContain("absolute_expires_at timestamptz");
		expect(sql).toContain("LANGUAGE plpgsql");
		expect(sql).toContain("SECURITY DEFINER");
		expect(sql).toContain("SET search_path = pg_catalog, public");
		expect(sql).toContain(
			"event_time + interval '15 minutes', session_record.absolute_expires_at",
		);
		expect(sql).not.toMatch(
			/event_time \+ interval '15 minutes',\s+absolute_expires_at/u,
		);
		expect(sql).not.toMatch(/\b(?:GRANT|REVOKE)\b/u);
	});
});
