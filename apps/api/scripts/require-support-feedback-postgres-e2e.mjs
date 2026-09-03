const required = [
	"SUPPORT_FEEDBACK_POSTGRES_E2E_DATABASE_URL",
	"SUPPORT_FEEDBACK_POSTGRES_E2E_CLEANUP_DATABASE_URL",
];

if (
	process.env.SUPPORT_FEEDBACK_POSTGRES_E2E !== "true" ||
	required.some((name) => (process.env[name] ?? "").trim().length === 0)
) {
	process.stderr.write(
		"Support-feedback PostgreSQL E2E requires explicit opt-in plus runtime and cleanup database URLs.\n",
	);
	process.exit(1);
}
