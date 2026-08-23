import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/u;
const MAXIMUM_MIGRATION_BYTES = 2 * 1024 * 1024;

export interface MigrationSource {
	readonly fileName: string;
	readonly contents: Buffer;
}

export interface MigrationDefinition {
	readonly version: number;
	readonly name: string;
	readonly fileName: string;
	readonly checksum: string;
	readonly sql: string;
}

export interface AppliedMigration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
}

export const MIGRATIONS_DIRECTORY = fileURLToPath(
	new URL("../../migrations/", import.meta.url),
);

function checksum(contents: Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

function sqlTokensOutsideQuotedContent(sql: string): readonly string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < sql.length) {
		const current = sql[index];
		const next = sql[index + 1];
		if (current === "-" && next === "-") {
			index += 2;
			while (index < sql.length && sql[index] !== "\n") index += 1;
			continue;
		}
		if (current === "/" && next === "*") {
			let depth = 1;
			index += 2;
			while (index < sql.length && depth > 0) {
				if (sql[index] === "/" && sql[index + 1] === "*") {
					depth += 1;
					index += 2;
				} else if (sql[index] === "*" && sql[index + 1] === "/") {
					depth -= 1;
					index += 2;
				} else {
					index += 1;
				}
			}
			if (depth !== 0) throw new Error("迁移 SQL 包含未闭合的块注释");
			continue;
		}
		if (current === "'" || current === '"') {
			const quote = current;
			const escapeString =
				quote === "'" &&
				(sql[index - 1] === "E" || sql[index - 1] === "e") &&
				!/\w/u.test(sql[index - 2] ?? "");
			index += 1;
			let closed = false;
			while (index < sql.length) {
				if (sql[index] === quote) {
					if (sql[index + 1] === quote) {
						index += 2;
						continue;
					}
					index += 1;
					closed = true;
					break;
				}
				if (escapeString && sql[index] === "\\") index += 1;
				index += 1;
			}
			if (!closed) throw new Error("迁移 SQL 包含未闭合的引号");
			continue;
		}
		if (current === "$") {
			const remainder = sql.slice(index);
			const delimiterMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(
				remainder,
			);
			if (delimiterMatch?.[0] !== undefined) {
				const delimiter = delimiterMatch[0];
				const closingIndex = sql.indexOf(delimiter, index + delimiter.length);
				if (closingIndex === -1) {
					throw new Error("迁移 SQL 包含未闭合的 dollar quote");
				}
				index = closingIndex + delimiter.length;
				continue;
			}
		}
		if (current !== undefined && /[A-Za-z_]/u.test(current)) {
			const start = index;
			index += 1;
			while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index] ?? "")) {
				index += 1;
			}
			tokens.push(sql.slice(start, index).toUpperCase());
			continue;
		}
		index += 1;
	}
	return tokens;
}

export function assertNoTransactionControl(sql: string): void {
	const tokens = sqlTokensOutsideQuotedContent(sql);
	for (const [index, token] of tokens.entries()) {
		const following = tokens[index + 1];
		if (
			token === "BEGIN" ||
			token === "COMMIT" ||
			token === "ROLLBACK" ||
			token === "ABORT" ||
			token === "END" ||
			token === "RELEASE" ||
			token === "SAVEPOINT" ||
			((token === "START" || token === "SET" || token === "PREPARE") &&
				following === "TRANSACTION")
		) {
			throw new Error("迁移 SQL 禁止自行控制事务");
		}
	}
}

export function buildMigrationPlan(
	sources: readonly MigrationSource[],
): readonly MigrationDefinition[] {
	if (sources.length === 0) {
		throw new Error("迁移目录必须至少包含一个版本化 SQL 文件");
	}

	const migrations = sources.map((source) => {
		const match = MIGRATION_FILE_PATTERN.exec(source.fileName);
		if (match === null) {
			throw new Error("迁移文件名必须使用四位连续版本号和安全名称");
		}
		if (
			source.contents.byteLength === 0 ||
			source.contents.byteLength > MAXIMUM_MIGRATION_BYTES
		) {
			throw new Error("迁移 SQL 大小超出安全范围");
		}
		if (
			source.contents[0] === 0xef &&
			source.contents[1] === 0xbb &&
			source.contents[2] === 0xbf
		) {
			throw new Error("迁移 SQL 禁止包含 UTF-8 BOM");
		}
		let sql: string;
		try {
			sql = new TextDecoder("utf-8", { fatal: true }).decode(source.contents);
		} catch {
			throw new Error("迁移 SQL 必须是严格有效的 UTF-8 文本");
		}
		if (sql.includes("\0") || sql.trim().length === 0) {
			throw new Error("迁移 SQL 不是有效的非空 UTF-8 文本");
		}
		assertNoTransactionControl(sql);
		const versionText = match[1];
		const name = match[2];
		if (versionText === undefined || name === undefined) {
			throw new Error("迁移文件名解析失败");
		}
		return Object.freeze({
			version: Number(versionText),
			name,
			fileName: source.fileName,
			checksum: checksum(source.contents),
			sql,
		});
	});

	migrations.sort((left, right) => left.version - right.version);
	for (const [index, migration] of migrations.entries()) {
		const expected = index + 1;
		if (migration.version !== expected) {
			throw new Error("迁移版本必须从 0001 开始且连续无缺号");
		}
		if (index > 0 && migrations[index - 1]?.fileName === migration.fileName) {
			throw new Error("迁移文件名不能重复");
		}
	}
	return Object.freeze(migrations);
}

export async function loadMigrationPlan(): Promise<
	readonly MigrationDefinition[]
> {
	const configuredRootStat = await lstat(MIGRATIONS_DIRECTORY);
	if (
		!configuredRootStat.isDirectory() ||
		configuredRootStat.isSymbolicLink()
	) {
		throw new Error("固定迁移路径必须是仓库内的普通目录");
	}
	const canonicalRoot = await realpath(MIGRATIONS_DIRECTORY);
	const rootStat = await lstat(canonicalRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error("固定迁移路径必须是普通目录");
	}

	const entries = await readdir(canonicalRoot, { withFileTypes: true });
	const sources: MigrationSource[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error("迁移目录只能包含普通 SQL 文件");
		}
		if (!MIGRATION_FILE_PATTERN.test(entry.name)) {
			throw new Error("迁移目录包含未版本化或名称不安全的文件");
		}
		const candidate = path.join(canonicalRoot, entry.name);
		const canonicalCandidate = await realpath(candidate);
		if (path.dirname(canonicalCandidate) !== canonicalRoot) {
			throw new Error("迁移文件不得逃逸固定迁移目录");
		}
		const candidateStat = await lstat(candidate);
		if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
			throw new Error("迁移文件必须是固定目录内的普通文件");
		}
		sources.push({
			fileName: entry.name,
			contents: await readFile(canonicalCandidate),
		});
	}
	return buildMigrationPlan(sources);
}

export function validateAppliedMigrations(
	plan: readonly MigrationDefinition[],
	applied: readonly AppliedMigration[],
	requireComplete: boolean,
): void {
	if (applied.length > plan.length) {
		throw new Error("数据库包含当前构建未知的迁移版本");
	}
	for (const [index, record] of applied.entries()) {
		const expectedVersion = index + 1;
		if (record.version !== expectedVersion) {
			throw new Error("数据库迁移记录存在缺号或乱序");
		}
		const expected = plan[index];
		if (expected === undefined) {
			throw new Error("数据库包含当前构建未知的迁移版本");
		}
		if (record.name !== expected.name) {
			throw new Error("数据库迁移名称与当前构建不一致");
		}
		if (record.checksum !== expected.checksum) {
			throw new Error("数据库迁移校验和发生漂移");
		}
	}
	if (requireComplete && applied.length !== plan.length) {
		throw new Error("数据库结构版本落后于当前构建");
	}
}
