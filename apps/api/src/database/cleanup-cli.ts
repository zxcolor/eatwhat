import type { PoolClient } from "pg";
import { safeDatabaseCliFailureMessage } from "./database-cli-errors.js";
import {
	loadMaintenanceDatabaseConfig,
	readNodeEnvironment,
} from "./database-config.js";
import type { SqlClient } from "./migration-runner.js";
import { runRetentionCleanupWithClient } from "./retention-cleanup.js";
import { createStandalonePool } from "./standalone-pool.js";

function readExecuteMode(args: readonly string[]): boolean {
	if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) {
		return false;
	}
	if (args.length === 1 && args[0] === "--execute") return true;
	throw new Error("数据保留清理只接受 --dry-run 或 --execute");
}

async function main(): Promise<void> {
	const execute = readExecuteMode(process.argv.slice(2));
	const nodeEnv = readNodeEnvironment(process.env);
	const config = loadMaintenanceDatabaseConfig(process.env, nodeEnv);
	const pool = createStandalonePool(
		config.connectionString,
		config.ssl,
		"chi-shen-me-retention-cleanup",
	);
	let client: PoolClient | null = null;
	try {
		client = await pool.connect();
		const result = await runRetentionCleanupWithClient(
			client as unknown as SqlClient,
			execute,
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
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
		`${safeDatabaseCliFailureMessage("RETENTION_CLEANUP", error)}\n`,
	);
	process.exitCode = 1;
});
