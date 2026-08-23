import type { PoolClient } from "pg";
import { safeDatabaseCliFailureMessage } from "./database-cli-errors.js";
import {
	loadMigrationDatabaseConfig,
	readNodeEnvironment,
} from "./database-config.js";
import { loadMigrationPlan } from "./migration-plan.js";
import { runMigrationsWithClient, type SqlClient } from "./migration-runner.js";
import { createStandalonePool } from "./standalone-pool.js";

async function main(): Promise<void> {
	if (process.argv.length !== 2) {
		throw new Error("数据库迁移命令不接受路径或其他参数");
	}
	const nodeEnv = readNodeEnvironment(process.env);
	const config = loadMigrationDatabaseConfig(process.env, nodeEnv);
	const plan = await loadMigrationPlan();
	const pool = createStandalonePool(
		config.connectionString,
		config.ssl,
		"chi-shen-me-migrator",
	);
	let client: PoolClient | null = null;
	try {
		client = await pool.connect();
		const result = await runMigrationsWithClient(
			client as unknown as SqlClient,
			plan,
		);
		process.stdout.write(
			`${JSON.stringify({
				status: "ok",
				currentVersion: result.currentVersion,
				appliedVersions: result.appliedVersions,
			})}\n`,
		);
	} catch (error) {
		client?.release(true);
		client = null;
		throw error;
	} finally {
		client?.release();
		await pool.end().catch(() => undefined);
	}
}

main().catch((error: unknown) => {
	process.stderr.write(
		`${safeDatabaseCliFailureMessage("MIGRATION", error)}\n`,
	);
	process.exitCode = 1;
});
