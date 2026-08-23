import {
	Inject,
	Injectable,
	Logger,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { loadMigrationPlan } from "../database/migration-plan.js";
import {
	type SqlResult,
	verifySchemaWithClient,
} from "../database/migration-runner.js";
import {
	ADMIN_PROCESS_CONFIG,
	type AdminProcessConfig,
} from "./admin-process-config.js";

export const ADMIN_DATABASE_POOL_FACTORY = Symbol(
	"ADMIN_DATABASE_POOL_FACTORY",
);
export type AdminDatabasePoolFactory = (
	options: ConstructorParameters<typeof Pool>[0],
) => Pool;
export const systemAdminDatabasePoolFactory: AdminDatabasePoolFactory = (
	options,
) => new Pool(options);

export class AdminDatabaseQueryError extends Error {
	constructor(
		readonly databaseCode: string | null,
		readonly constraint: string | null,
	) {
		super("管理员数据库查询失败");
		this.name = "AdminDatabaseQueryError";
	}
}

interface RuntimeIdentityRow extends QueryResultRow {
	readonly runtime_role: string;
	readonly database_name: string;
	readonly server_port: number;
}

@Injectable()
export class AdminDatabasePool
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(AdminDatabasePool.name);
	private pool: Pool | null = null;

	constructor(
		@Inject(ADMIN_PROCESS_CONFIG) private readonly config: AdminProcessConfig,
		@Inject(ADMIN_DATABASE_POOL_FACTORY)
		private readonly poolFactory: AdminDatabasePoolFactory,
	) {}

	async onApplicationBootstrap(): Promise<void> {
		const database = this.config.admin.database;
		if (!this.config.admin.enabled) return;
		if (!database.enabled || database.connectionString === null) {
			throw new Error("管理员数据库配置不可用");
		}

		const pool = this.poolFactory({
			connectionString: database.connectionString,
			ssl: database.ssl,
			max: database.poolMaximum,
			connectionTimeoutMillis: database.connectionTimeoutMs,
			idleTimeoutMillis: database.idleTimeoutMs,
			statement_timeout: 5_000,
			application_name: "chi-shen-me-admin-api",
		});
		pool.on("error", () => {
			this.logger.error("管理员数据库连接池发生空闲连接错误");
		});
		this.pool = pool;

		let client: PoolClient | null = null;
		try {
			client = await pool.connect();
			const identity = await client.query<RuntimeIdentityRow>(
				"SELECT current_user AS runtime_role, current_database() AS database_name, inet_server_port() AS server_port",
			);
			const row = identity.rows[0];
			if (
				row === undefined ||
				row.runtime_role !== "admin_api_runtime" ||
				!this.expectedTargetMatches(row.database_name, row.server_port)
			) {
				throw new Error("unexpected administrator database identity");
			}
			const plan = await loadMigrationPlan();
			await verifySchemaWithClient(client, plan);
		} catch {
			this.pool = null;
			if (client !== null) {
				client.release(true);
				client = null;
			}
			await pool.end().catch(() => undefined);
			throw new Error("管理员数据库启动检查失败");
		} finally {
			client?.release();
		}
	}

	async onApplicationShutdown(): Promise<void> {
		const pool = this.pool;
		this.pool = null;
		if (pool !== null) await pool.end();
	}

	isAvailable(): boolean {
		return this.config.admin.enabled && this.pool !== null;
	}

	async query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[],
	): Promise<SqlResult<Row>> {
		if (this.pool === null) throw new Error("管理员数据库连接不可用");
		try {
			return await this.pool.query<Row>(text, values as unknown[] | undefined);
		} catch (error) {
			const candidate = error as {
				readonly code?: unknown;
				readonly constraint?: unknown;
			};
			const databaseCode =
				typeof candidate.code === "string" &&
				/^[0-9A-Z]{5}$/u.test(candidate.code)
					? candidate.code
					: null;
			const constraint =
				typeof candidate.constraint === "string" &&
				candidate.constraint === "admin_active_credential_limit"
					? candidate.constraint
					: null;
			throw new AdminDatabaseQueryError(databaseCode, constraint);
		}
	}

	private expectedTargetMatches(
		databaseName: string,
		serverPort: number,
	): boolean {
		const connectionString = this.config.admin.database.connectionString;
		if (connectionString === null) return false;
		try {
			const url = new URL(connectionString);
			const expectedDatabase = decodeURIComponent(url.pathname.slice(1));
			return (
				databaseName === expectedDatabase &&
				String(serverPort) === (url.port || "5432")
			);
		} catch {
			return false;
		}
	}
}
