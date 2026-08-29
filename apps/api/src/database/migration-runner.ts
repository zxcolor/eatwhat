import type { QueryResultRow } from "pg";
import type {
	AppliedMigration,
	MigrationDefinition,
} from "./migration-plan.js";
import { validateAppliedMigrations } from "./migration-plan.js";

export const MIGRATION_ADVISORY_LOCK = Object.freeze([
	1_129_310_029, 1_296_645_202,
] as const);

export interface SqlResult<Row extends QueryResultRow = QueryResultRow> {
	readonly rows: Row[];
	readonly rowCount: number | null;
}

export interface SqlClient {
	query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[],
	): Promise<SqlResult<Row>>;
}

const CREATE_MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name varchar(120) NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,119}$'),
  checksum varchar(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

interface AppliedMigrationRow extends QueryResultRow {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
}

interface AdvisoryLockRow extends QueryResultRow {
	readonly locked: boolean;
}

export interface MigrationLockOptions {
	readonly maximumAttempts: number;
	readonly retryDelayMs: number;
	readonly wait: (milliseconds: number) => Promise<void>;
}

const DEFAULT_LOCK_OPTIONS: MigrationLockOptions = Object.freeze({
	maximumAttempts: 20,
	retryDelayMs: 250,
	wait: (milliseconds: number) =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, milliseconds);
		}),
});

async function acquireMigrationLock(
	client: SqlClient,
	options: MigrationLockOptions,
): Promise<void> {
	if (
		!Number.isInteger(options.maximumAttempts) ||
		options.maximumAttempts < 1 ||
		options.maximumAttempts > 100 ||
		!Number.isInteger(options.retryDelayMs) ||
		options.retryDelayMs < 0 ||
		options.retryDelayMs > 1_000
	) {
		throw new Error("迁移锁等待配置无效");
	}
	for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
		const result = await client.query<AdvisoryLockRow>(
			"SELECT pg_try_advisory_lock($1, $2) AS locked",
			[MIGRATION_ADVISORY_LOCK[0], MIGRATION_ADVISORY_LOCK[1]],
		);
		if (result.rows[0]?.locked === true) return;
		if (attempt < options.maximumAttempts) {
			await options.wait(options.retryDelayMs);
		}
	}
	throw new Error("数据库迁移锁在限定时间内不可用");
}

function normalizeAppliedRows(
	rows: readonly AppliedMigrationRow[],
): readonly AppliedMigration[] {
	return rows.map((row) => {
		if (
			!Number.isInteger(row.version) ||
			typeof row.name !== "string" ||
			typeof row.checksum !== "string"
		) {
			throw new Error("数据库迁移记录格式无效");
		}
		return Object.freeze({
			version: row.version,
			name: row.name,
			checksum: row.checksum,
		});
	});
}

async function readAppliedMigrations(
	client: SqlClient,
): Promise<readonly AppliedMigration[]> {
	const result = await client.query<AppliedMigrationRow>(
		"SELECT version, name, checksum FROM public.schema_migrations ORDER BY version ASC",
	);
	return normalizeAppliedRows(result.rows);
}

export interface MigrationRunResult {
	readonly appliedVersions: readonly number[];
	readonly currentVersion: number;
}

export async function runMigrationsWithClient(
	client: SqlClient,
	plan: readonly MigrationDefinition[],
	lockOptions: MigrationLockOptions = DEFAULT_LOCK_OPTIONS,
): Promise<MigrationRunResult> {
	let locked = false;
	try {
		await acquireMigrationLock(client, lockOptions);
		locked = true;

		await client.query("BEGIN");
		try {
			await client.query("SET LOCAL search_path TO pg_catalog, public");
			await client.query(CREATE_MIGRATION_TABLE_SQL);
			await client.query("COMMIT");
		} catch {
			await client.query("ROLLBACK").catch(() => undefined);
			throw new Error("无法初始化数据库迁移记录表");
		}

		const applied = await readAppliedMigrations(client);
		validateAppliedMigrations(plan, applied, false);
		const appliedVersions: number[] = [];

		for (const migration of plan.slice(applied.length)) {
			await client.query("BEGIN");
			try {
				await client.query("SET LOCAL search_path TO pg_catalog, public");
				await client.query(migration.sql);
				await client.query(
					"INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
					[migration.version, migration.name, migration.checksum],
				);
				await client.query("COMMIT");
				appliedVersions.push(migration.version);
			} catch {
				await client.query("ROLLBACK").catch(() => undefined);
				throw new Error(
					`数据库迁移 ${String(migration.version).padStart(4, "0")} 执行失败`,
				);
			}
		}

		return Object.freeze({
			appliedVersions: Object.freeze(appliedVersions),
			currentVersion: plan.at(-1)?.version ?? 0,
		});
	} finally {
		if (locked) {
			await client
				.query("SELECT pg_advisory_unlock($1, $2)", [
					MIGRATION_ADVISORY_LOCK[0],
					MIGRATION_ADVISORY_LOCK[1],
				])
				.catch(() => undefined);
		}
	}
}

export async function verifySchemaWithClient(
	client: SqlClient,
	plan: readonly MigrationDefinition[],
	allowedPendingFinalMigration?: Readonly<{
		readonly version: number;
		readonly name: string;
		readonly fileName: string;
	}>,
): Promise<void> {
	const tableResult = await client.query<{
		readonly table_name: string | null;
	}>("SELECT to_regclass('public.schema_migrations')::text AS table_name");
	if (tableResult.rows[0]?.table_name !== "schema_migrations") {
		throw new Error("数据库尚未执行版本化迁移");
	}
	const applied = await readAppliedMigrations(client);
	if (allowedPendingFinalMigration === undefined) {
		validateAppliedMigrations(plan, applied, true);
		return;
	}

	validateAppliedMigrations(plan, applied, false);
	if (applied.length === plan.length) return;
	const finalMigration = plan.at(-1);
	if (
		applied.length !== plan.length - 1 ||
		finalMigration?.version !== allowedPendingFinalMigration.version ||
		finalMigration.name !== allowedPendingFinalMigration.name ||
		finalMigration.fileName !== allowedPendingFinalMigration.fileName
	) {
		throw new Error("数据库结构版本不符合受控认证迁移过渡条件");
	}
}
