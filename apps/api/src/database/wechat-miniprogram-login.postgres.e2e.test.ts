import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";
import {
	runMigrationsWithClient,
	verifySchemaWithClient,
} from "./migration-runner.js";

// Explicitly opt in against a new loopback-only temporary PostgreSQL cluster.
// The data_directory check prevents using an existing development/production DB.
const enabled = process.env.WECHAT_MINIPROGRAM_POSTGRES_E2E === "1";
const port = Number(process.env.WECHAT_MINIPROGRAM_POSTGRES_PORT);
const psql = process.env.WECHAT_MINIPROGRAM_PSQL ?? "";
const roleNames = [
	"schema_migrator",
	"api_runtime",
	"retention_worker",
	"admin_api_runtime",
	"data_export_worker",
];
const databaseName = `schema14test_${randomUUID().replaceAll("-", "")}`;
const hash = () => randomBytes(32).toString("hex");
const unionHash = "ab".repeat(32);
const realm = "synthetic-realm";
const keyVersion = "dedup.v1";
const rolesPath = new URL(
	"../../../../infra/postgres/role-grants.sql",
	import.meta.url,
);
let bootstrap: Client | undefined;
let database: Client | undefined;
let databaseCreated = false;

function connection(user = "postgres", name = databaseName): Client {
	return new Client({
		host: "127.0.0.1",
		port,
		user,
		database: name,
		application_name: "eatwhat-schema14-synthetic-tests",
	});
}
async function runPsql(file: URL): Promise<void> {
	const result = spawnSync(
		psql,
		[
			"-X",
			"-q",
			"-h",
			"127.0.0.1",
			"-p",
			String(port),
			"-U",
			"postgres",
			"-d",
			databaseName,
			"-v",
			"ON_ERROR_STOP=1",
			"-v",
			"migration_owner=schema_migrator",
			"-v",
			"runtime_role=api_runtime",
			"-v",
			"maintenance_role=retention_worker",
			"-v",
			"admin_runtime_role=admin_api_runtime",
			"-v",
			"export_worker_role=data_export_worker",
		],
		{
			input: await readFile(file, "utf8"),
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
			windowsHide: true,
			env: { ...process.env, PGCLIENTENCODING: "UTF8" },
		},
	);
	if (result.status !== 0)
		throw new Error(
			`Isolated PostgreSQL fixture failed (${fileURLToPath(file)}): ${result.stderr}`,
		);
}
function db(): Client {
	if (!database) throw new Error("isolated database is not initialized");
	return database;
}

async function createIdentity(
	options: { lookup?: string; dedup?: string; lookupVersion?: string } = {},
) {
	const userId = randomUUID();
	const bindingId = randomUUID();
	const lookup = options.lookup ?? hash();
	const dedup = options.dedup ?? hash();
	await db().query("SET LOCAL ROLE schema_migrator");
	await db().query("INSERT INTO public.users(id) VALUES ($1)", [userId]);
	await db().query(
		`INSERT INTO public.identity_bindings (
		id,user_id,identity_type,lookup_hash,lookup_hash_algorithm,lookup_hash_key_version,
		dedup_hash,dedup_hash_algorithm,dedup_hash_key_version,masked_display_hint,is_primary,verified_at
	) VALUES ($1,$2,'WECHAT',$3,'HMAC-SHA256',$4,$5,'HMAC-SHA256',$6,'微信账号',false,clock_timestamp())`,
		[
			bindingId,
			userId,
			lookup,
			options.lookupVersion ?? "lookup.v2",
			dedup,
			keyVersion,
		],
	);
	return { userId, bindingId, lookup, dedup };
}
async function proof(
	options: {
		lookup?: string;
		dedup?: string;
		lookupVersion?: string;
		union?: string | null;
		unionVersion?: string;
		unionRealm?: string;
		purpose?: "LOGIN" | "BIND";
		target?: string;
		consume?: boolean;
	} = {},
) {
	const id = randomUUID();
	const stateHash = hash();
	const flow = hash();
	const device = hash();
	const operation = options.purpose === "BIND" ? hash() : null;
	await db().query("SET LOCAL ROLE api_runtime");
	await db().query(
		`INSERT INTO public.oauth_states (
		id,provider,purpose,state_hash,state_hash_algorithm,flow_reference_hash,operation_target_hash,
		target_user_id,device_hash,hash_key_version,expires_at,retain_until
	) VALUES ($1,'WECHAT',$2,$3,'HMAC-SHA256',$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '1 hour')`,
		[
			id,
			options.purpose ?? "LOGIN",
			stateHash,
			flow,
			operation,
			options.target ?? null,
			device,
			keyVersion,
		],
	);
	const parameters = [
		id,
		"WECHAT",
		options.purpose ?? "LOGIN",
		flow,
		operation,
		options.target ?? null,
		device,
		options.lookup ?? hash(),
		options.lookupVersion ?? "lookup.v2",
		options.dedup ?? hash(),
		keyVersion,
		options.union === null ? null : (options.unionRealm ?? realm),
		options.union === null ? null : (options.union ?? unionHash),
		options.union === null ? null : (options.unionVersion ?? keyVersion),
	];
	if (options.consume !== false) {
		const consumed = await db().query(
			"SELECT public.consume_oauth_state_with_wechat_union($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS changed",
			parameters,
		);
		expect(consumed.rows[0]?.changed).toBe(true);
	}
	return { id, parameters, stateHash };
}
async function originalAccount() {
	const identity = await createIdentity();
	const original = await proof({
		lookup: identity.lookup,
		dedup: identity.dedup,
	});
	const recorded = await db().query(
		"SELECT public.record_wechat_union_alias_from_consumed_state($1,$2) AS changed",
		[original.id, identity.bindingId],
	);
	expect(recorded.rows[0]?.changed).toBe(true);
	return identity;
}
async function resolve(id: string) {
	await db().query("SET LOCAL ROLE api_runtime");
	return (
		await db().query(
			"SELECT * FROM public.resolve_wechat_miniprogram_user_from_consumed_state($1)",
			[id],
		)
	).rows;
}

describe.skipIf(!enabled)(
	"WeChat Mini Program isolated PostgreSQL migration and ACL",
	() => {
		beforeAll(async () => {
			if (
				!Number.isInteger(port) ||
				port <= 1024 ||
				port >= 65536 ||
				port === 5432 ||
				!psql
			)
				throw new Error(
					"Explicit temporary PostgreSQL port and psql binary are required",
				);
			bootstrap = connection("postgres", "postgres");
			await bootstrap.connect();
			const directory = String(
				(await bootstrap.query("SHOW data_directory")).rows[0]?.data_directory,
			).replaceAll("\\", "/");
			if (!/\/eatwhat-schema14-[a-f0-9]{32}\/data$/u.test(directory))
				throw new Error("Refusing a non-isolated PostgreSQL data directory");
			for (const role of roleNames) {
				if (
					!(
						await bootstrap.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
							role,
						])
					).rowCount
				) {
					await bootstrap.query(
						`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
					);
				}
			}
			await bootstrap.query(
				`CREATE DATABASE ${databaseName} OWNER schema_migrator TEMPLATE template0 ENCODING 'UTF8'`,
			);
			databaseCreated = true;
			database = connection();
			await database.connect();
			await db().query(
				"CREATE EXTENSION pgcrypto; CREATE EXTENSION postgis; ALTER SCHEMA public OWNER TO schema_migrator; SET ROLE schema_migrator",
			);
			const plan = await loadMigrationPlan();
			expect(
				(await runMigrationsWithClient(db(), plan.slice(0, 13))).currentVersion,
			).toBe(13);
			await runPsql(rolesPath);
			await runPsql(
				new URL(
					"../../../../infra/postgres/verify-admin-config-control.sql",
					import.meta.url,
				),
			);
			expect(
				(
					await db().query(
						"SELECT to_regprocedure('public.resolve_wechat_miniprogram_user_from_consumed_state(uuid)') AS routine",
					)
				).rows[0]?.routine,
			).toBeNull();
			expect(
				(await runMigrationsWithClient(db(), plan)).appliedVersions,
			).toEqual([14]);
			await runPsql(rolesPath);
			await runPsql(
				new URL(
					"../../../../infra/postgres/verify-wechat-miniprogram-login.sql",
					import.meta.url,
				),
			);
			await runPsql(
				new URL(
					"../../../../infra/postgres/verify-admin-config-control.sql",
					import.meta.url,
				),
			);
			await verifySchemaWithClient(db(), plan);
			expect(
				(await runMigrationsWithClient(db(), plan)).appliedVersions,
			).toEqual([]);
			await db().query("RESET ROLE");
		}, 60000);
		beforeEach(async () => {
			await db().query("BEGIN; SET LOCAL search_path TO pg_catalog, public");
		});
		afterEach(async () => {
			await database?.query("ROLLBACK");
		});
		afterAll(async () => {
			await database?.end();
			if (databaseCreated && bootstrap)
				await bootstrap.query(`DROP DATABASE ${databaseName}`);
			await bootstrap?.end();
		}, 10000);

		it("resolves the existing account using a distinct app OpenID and mixed lookup/alias key versions", async () => {
			const account = await originalAccount();
			const mini = await proof();
			expect(await resolve(mini.id)).toEqual([
				{ result: "SUCCESS", user_id: account.userId },
			]);
			await db().query("SET LOCAL ROLE schema_migrator");
			expect(
				(
					await db().query(
						"SELECT count(*)::int AS count FROM public.identity_bindings",
					)
				).rows[0]?.count,
			).toBe(1);
			expect(
				(await db().query("SELECT count(*)::int AS count FROM public.users"))
					.rows[0]?.count,
			).toBe(1);
		});
		it("rejects missing, unconsumed, wrong-purpose and missing-UnionID proofs", async () => {
			const account = await originalAccount();
			const pending = await proof({ consume: false });
			const bind = await proof({ purpose: "BIND", target: account.userId });
			const noUnion = await proof({ union: null });
			for (const id of [randomUUID(), pending.id, bind.id])
				expect(await resolve(id)).toEqual([
					{ result: "INVALID_CREDENTIALS", user_id: null },
				]);
			expect(await resolve(noUnion.id)).toEqual([
				{ result: "IDENTITY_NOT_BOUND", user_id: null },
			]);
		});
		it("does not resolve across realms or alias key versions", async () => {
			await originalAccount();
			const otherRealm = await proof({ unionRealm: "synthetic-other-realm" });
			const otherKey = await proof({ unionVersion: "dedup.v2" });
			expect(await resolve(otherRealm.id)).toEqual([
				{ result: "IDENTITY_NOT_BOUND", user_id: null },
			]);
			expect(await resolve(otherKey.id)).toEqual([
				{ result: "IDENTITY_CONFLICT", user_id: null },
			]);
		});
		it("rejects either OpenID lookup or dedup owner conflicting with the UnionID account", async () => {
			await originalAccount();
			const another = await createIdentity();
			for (const options of [
				{ lookup: another.lookup },
				{ dedup: another.dedup },
			]) {
				const mini = await proof(options);
				expect(await resolve(mini.id)).toEqual([
					{ result: "IDENTITY_CONFLICT", user_id: null },
				]);
			}
		});
		it("rejects a revoked original binding", async () => {
			const account = await originalAccount();
			const mini = await proof();
			await db().query(
				"SELECT public.revoke_non_primary_identity_binding($1,$2)",
				[account.bindingId, account.userId],
			);
			expect(await resolve(mini.id)).toEqual([
				{ result: "INVALID_CREDENTIALS", user_id: null },
			]);
		});
		it.each(["LOCKED", "DELETION_PENDING"])(
			"rejects a %s account",
			async (status) => {
				const account = await originalAccount();
				const mini = await proof();
				await db().query("SET LOCAL ROLE schema_migrator");
				await db().query(
					"SELECT set_config('chi_shen_me.account_deletion_transition','enabled',true)",
				);
				await db().query(
					"UPDATE public.users SET status=$1,updated_at=clock_timestamp(),disabled_at=CASE WHEN $1='DELETION_PENDING' THEN clock_timestamp() ELSE NULL END WHERE id=$2",
					[status, account.userId],
				);
				expect(await resolve(mini.id)).toEqual([
					{ result: "INVALID_CREDENTIALS", user_id: null },
				]);
			},
		);
		it("rejects consumed proof older than fifteen minutes", async () => {
			await originalAccount();
			const mini = await proof();
			// Only fixture bootstrap can shift all timestamps to model elapsed time.
			await db().query(
				"RESET ROLE; SET LOCAL session_replication_role=replica",
			);
			await db().query(
				"UPDATE public.oauth_states SET created_at=created_at-interval '16 minutes', consumed_at=consumed_at-interval '16 minutes', expires_at=expires_at-interval '16 minutes', retain_until=retain_until-interval '16 minutes' WHERE id=$1",
				[mini.id],
			);
			await db().query("SET LOCAL session_replication_role=origin");
			expect(await resolve(mini.id)).toEqual([
				{ result: "INVALID_CREDENTIALS", user_id: null },
			]);
		});
		it("uses existing runtime INSERT/SELECT ACL for atomic code claims and consumes once", async () => {
			const claim = await proof({ consume: false });
			const duplicate = await db().query(
				`INSERT INTO public.oauth_states (
			provider,purpose,state_hash,state_hash_algorithm,flow_reference_hash,device_hash,hash_key_version,expires_at,retain_until
		) VALUES ('WECHAT','LOGIN',$1,'HMAC-SHA256',$2,$3,$4,clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '1 hour')
		ON CONFLICT (state_hash) DO NOTHING RETURNING id`,
				[claim.stateHash, hash(), hash(), keyVersion],
			);
			expect(duplicate.rowCount).toBe(0);
			const consumeSql =
				"SELECT public.consume_oauth_state_with_wechat_union($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS changed";
			expect(
				(await db().query(consumeSql, claim.parameters)).rows[0]?.changed,
			).toBe(true);
			expect(
				(await db().query(consumeSql, claim.parameters)).rows[0]?.changed,
			).toBe(false);
		});
		it("provides no alias table access or resolver execution to unrelated service roles or PUBLIC", async () => {
			await db().query("RESET ROLE");
			for (const role of roleNames.slice(1)) {
				const acl = await db().query(
					`SELECT
				has_table_privilege($1,'public.wechat_union_aliases','SELECT,INSERT,UPDATE,DELETE') AS table_access,
				has_function_privilege($1,'public.resolve_wechat_miniprogram_user_from_consumed_state(uuid)','EXECUTE') AS execute`,
					[role],
				);
				expect(acl.rows[0]).toEqual({
					table_access: false,
					execute: role === "api_runtime",
				});
			}
			const publicAcl =
				await db().query(`SELECT count(*)::int AS count FROM pg_proc p,
			LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
			WHERE p.oid='public.resolve_wechat_miniprogram_user_from_consumed_state(uuid)'::regprocedure AND a.grantee=0`);
			expect(publicAcl.rows[0]?.count).toBe(0);
		});
	},
);
