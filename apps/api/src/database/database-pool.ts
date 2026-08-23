import {
	Inject,
	Injectable,
	Logger,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { loadMigrationPlan } from "./migration-plan.js";
import { type SqlResult, verifySchemaWithClient } from "./migration-runner.js";

export const DATABASE_POOL_FACTORY = Symbol("DATABASE_POOL_FACTORY");

// node-postgres supports a per-query query_timeout at runtime, while its
// QueryConfig declaration currently exposes it only on ClientConfig. Keeping
// the option in a named value avoids an unsafe cast and preserves the bound.
const READINESS_QUERY = Object.freeze({
	text: "SELECT 1",
	query_timeout: 2_000,
});

/** Safe driver metadata only; never preserves a PostgreSQL message/detail. */
export class DatabaseQueryError extends Error {
	constructor(readonly sqlState: string | null) {
		super("数据库查询执行失败");
		this.name = "DatabaseQueryError";
	}
}

export type DatabasePoolFactory = (
	options: ConstructorParameters<typeof Pool>[0],
) => Pool;
export const systemDatabasePoolFactory: DatabasePoolFactory = (options) =>
	new Pool(options);

export interface DatabaseTransaction {
	query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[],
	): Promise<SqlResult<Row>>;
}

@Injectable()
export class DatabasePool
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(DatabasePool.name);
	private pool: Pool | null = null;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(DATABASE_POOL_FACTORY)
		private readonly poolFactory: DatabasePoolFactory,
	) {}

	async onApplicationBootstrap(): Promise<void> {
		if (!this.config.database.enabled) return;
		const connectionString = this.config.database.connectionString;
		if (connectionString === null) {
			throw new Error("数据库已启用但缺少有效连接配置");
		}
		const pool = this.poolFactory({
			connectionString,
			ssl: this.config.database.ssl,
			max: this.config.database.poolMaximum,
			connectionTimeoutMillis: this.config.database.connectionTimeoutMs,
			idleTimeoutMillis: this.config.database.idleTimeoutMs,
			statement_timeout: 15_000,
			application_name: "chi-shen-me-api",
		});
		pool.on("error", () => {
			this.logger.error("数据库连接池发生空闲连接错误");
		});
		this.pool = pool;

		let client: PoolClient | null = null;
		try {
			client = await pool.connect();
			await client.query("SELECT 1");
			const plan = await loadMigrationPlan();
			await verifySchemaWithClient(client, plan);
		} catch {
			this.pool = null;
			if (client !== null) {
				client.release(true);
				client = null;
			}
			await pool.end().catch(() => undefined);
			throw new Error("数据库启动检查失败");
		} finally {
			client?.release();
		}
	}

	async onApplicationShutdown(): Promise<void> {
		const pool = this.pool;
		this.pool = null;
		if (pool !== null) await pool.end();
	}

	isEnabled(): boolean {
		return this.config.database.enabled;
	}

	/**
	 * A bounded, read-only readiness probe. Disabled databases are intentionally
	 * skipped outside production; an enabled database is ready only while the
	 * already-created runtime pool can complete a trivial query.
	 */
	async isReady(): Promise<boolean> {
		if (!this.config.database.enabled) return true;
		const pool = this.pool;
		if (pool === null) return false;
		try {
			await pool.query(READINESS_QUERY);
			return true;
		} catch {
			return false;
		}
	}

	async query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[],
	): Promise<SqlResult<Row>> {
		if (this.pool === null) throw new Error("数据库连接不可用");
		try {
			return await this.pool.query<Row>(text, values as unknown[] | undefined);
		} catch (error) {
			const candidate = (error as { readonly code?: unknown })?.code;
			const sqlState =
				typeof candidate === "string" && /^[0-9A-Z]{5}$/u.test(candidate)
					? candidate
					: null;
			throw new DatabaseQueryError(sqlState);
		}
	}

	async withTransaction<Result>(
		work: (transaction: DatabaseTransaction) => Promise<Result>,
	): Promise<Result> {
		if (this.pool === null) throw new Error("数据库连接不可用");
		let client: PoolClient | null = null;
		try {
			client = await this.pool.connect();
			await client.query("BEGIN");
			await client.query("SET LOCAL search_path TO pg_catalog, public");
			const transactionClient = client;
			const transaction: DatabaseTransaction = Object.freeze({
				query: async <Row extends QueryResultRow = QueryResultRow>(
					text: string,
					values?: readonly unknown[],
				): Promise<SqlResult<Row>> => {
					try {
						return await transactionClient.query<Row>(
							text,
							values as unknown[] | undefined,
						);
					} catch {
						throw new Error("数据库事务查询执行失败");
					}
				},
			});
			const result = await work(transaction);
			await client.query("COMMIT");
			return result;
		} catch {
			if (client !== null) {
				await client.query("ROLLBACK").catch(() => undefined);
			}
			throw new Error("数据库事务执行失败");
		} finally {
			client?.release();
		}
	}
}
