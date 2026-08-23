import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { loadMigrationPlan } from "../database/migration-plan.js";
import {
	type SqlClient,
	verifySchemaWithClient,
} from "../database/migration-runner.js";
import { createStandalonePool } from "../database/standalone-pool.js";
import { loadExportWorkerSupportFeedbackEncryptionKeyRing } from "../support-feedback/support-feedback-config.js";
import { createAliyunOssExportArtifactStore } from "./aliyun-oss-export-artifact.store.js";
import {
	createExportWorkerLeaseIdentity,
	DataExportWorker,
} from "./export-worker.js";
import { PostgresDataExportWorkerRepository } from "./export-worker.repository.js";
import {
	assertDataExportWorkerKeyCoverage,
	loadDataExportWorkerRuntimeConfig,
} from "./export-worker-config.js";

const LEASE_IDENTITY_VERSION = "process-v1";

async function main(): Promise<void> {
	if (process.argv.length !== 2) {
		throw new Error("数据导出工作器不接受命令行参数");
	}
	const config = loadDataExportWorkerRuntimeConfig(process.env);
	let supportKeys: ReturnType<
		typeof loadExportWorkerSupportFeedbackEncryptionKeyRing
	> | null = null;
	let pool: Pool | null = null;
	let stopping = false;
	const requestStop = () => {
		stopping = true;
	};
	process.once("SIGINT", requestStop);
	process.once("SIGTERM", requestStop);
	try {
		supportKeys = loadExportWorkerSupportFeedbackEncryptionKeyRing(process.env);
		const artifactStore = await createAliyunOssExportArtifactStore(
			config.artifacts,
		);
		if (artifactStore === null) throw new Error("数据导出对象存储未就绪");
		pool = createStandalonePool(
			config.database.connectionString,
			config.database.ssl,
			"chi-shen-me-data-export-worker",
		);
		await verifyWorkerDatabase(
			pool,
			config.artifacts.locatorKeyRing,
			supportKeys,
		);

		const leaseKey = randomBytes(32);
		let identity: ReturnType<typeof createExportWorkerLeaseIdentity>;
		try {
			identity = createExportWorkerLeaseIdentity(
				LEASE_IDENTITY_VERSION,
				leaseKey,
			);
		} finally {
			leaseKey.fill(0);
		}
		const worker = new DataExportWorker(
			new PostgresDataExportWorkerRepository(pool),
			artifactStore,
			config.artifacts.locatorKeyRing,
			supportKeys,
			identity,
			{
				leaseSeconds: config.leaseSeconds,
				maximumArtifactBytes: config.artifacts.maximumArtifactBytes,
			},
		);

		process.stdout.write("数据导出工作器已就绪\n");
		while (!stopping) {
			await worker.runOnce();
			if (!stopping) await wait(config.pollIntervalMs);
		}
	} finally {
		process.removeListener("SIGINT", requestStop);
		process.removeListener("SIGTERM", requestStop);
		await pool?.end().catch(() => undefined);
		config.artifacts.locatorKeyRing.destroy();
		supportKeys?.destroy();
	}
}

async function verifyWorkerDatabase(
	pool: Pool,
	locatorKeyRing: Parameters<typeof assertDataExportWorkerKeyCoverage>[0],
	supportFeedbackEncryptionKeyRing: Parameters<
		typeof assertDataExportWorkerKeyCoverage
	>[1],
): Promise<void> {
	let client: PoolClient | null = null;
	try {
		client = await pool.connect();
		await client.query("SELECT 1");
		await verifySchemaWithClient(
			client as unknown as SqlClient,
			await loadMigrationPlan(),
		);
		const requiredLocatorVersions = await requiredKeyVersions(
			client,
			"SELECT key_version FROM public.export_artifact_required_locator_key_versions()",
		);
		const requiredSupportVersions = await requiredKeyVersions(
			client,
			`SELECT key_version
			 FROM public.support_feedback_required_key_versions()
			 WHERE key_purpose = 'ENCRYPTION'`,
		);
		assertDataExportWorkerKeyCoverage(
			locatorKeyRing,
			supportFeedbackEncryptionKeyRing,
			requiredLocatorVersions,
			requiredSupportVersions,
		);
	} catch {
		client?.release(true);
		client = null;
		throw new Error("数据导出工作器数据库启动检查失败");
	} finally {
		client?.release();
	}
}

async function requiredKeyVersions(
	client: PoolClient,
	sql: string,
): Promise<readonly string[]> {
	const result = await client.query(sql);
	if (!Array.isArray(result.rows) || result.rows.length > 4) {
		throw new Error("数据导出工作器密钥覆盖查询失败");
	}
	return Object.freeze(
		result.rows.map((row: unknown) => {
			if (
				typeof row !== "object" ||
				row === null ||
				Array.isArray(row) ||
				Object.keys(row).length !== 1 ||
				!("key_version" in row) ||
				typeof row.key_version !== "string"
			) {
				throw new Error("数据导出工作器密钥覆盖查询失败");
			}
			return row.key_version;
		}),
	);
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

main().catch(() => {
	process.stderr.write("数据导出工作器启动或运行失败\n");
	process.exitCode = 1;
});
