import { describe, expect, it } from "vitest";
import { safeDatabaseCliFailureMessage } from "./database-cli-errors.js";

describe("database CLI error redaction", () => {
	it.each(["MIGRATION", "RETENTION_CLEANUP"] as const)(
		"never reflects lower-level infrastructure details for %s",
		(operation) => {
			const privateDetails =
				"postgresql://secret-user:secret-pass@secret-host/private-db?sslmode=disable";
			const message = safeDatabaseCliFailureMessage(
				operation,
				new Error(privateDetails),
			);
			expect(message).not.toContain("secret-user");
			expect(message).not.toContain("secret-pass");
			expect(message).not.toContain("secret-host");
			expect(message).not.toContain("private-db");
		},
	);
});
