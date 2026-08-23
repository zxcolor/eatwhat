import { Pool } from "pg";
import type { DatabaseSslConfig } from "./database-config.js";

export function createStandalonePool(
	connectionString: string,
	ssl: DatabaseSslConfig,
	applicationName: string,
): Pool {
	const pool = new Pool({
		connectionString,
		ssl,
		max: 2,
		connectionTimeoutMillis: 10_000,
		idleTimeoutMillis: 5_000,
		statement_timeout: 60_000,
		application_name: applicationName,
	});
	pool.on("error", () => {
		process.stderr.write("数据库维护连接池发生空闲连接错误\n");
	});
	return pool;
}
