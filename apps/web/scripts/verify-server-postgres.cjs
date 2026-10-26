#!/usr/bin/env node
'use strict';

// Destructive statements below target only a fresh, isolated, loopback test
// cluster created by this process. No connection string or production host is accepted.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyCandidate } = require('./prepare-server-candidate.cjs');

async function run() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--candidate', '--pg-bin'].includes(args[i]) || !args[i + 1]) throw new Error('Use --candidate <prepared directory> --pg-bin <installed PostgreSQL bin>');
    options[args[i].slice(2)] = args[i + 1];
  }
  const candidate = fs.realpathSync(options.candidate);
  verifyCandidate(candidate);
  const bin = fs.realpathSync(options['pg-bin']);
  const scratch = path.resolve(__dirname, '../../../.codex-tmp');
  const work = fs.mkdtempSync(path.join(scratch, 'web-postgres-'));
  const data = path.join(work, 'data');
  const transcript = [];
  const executable = name => path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  const exec = (name, argv, input, expectFailure = false) => {
    const result = spawnSync(executable(name), argv, {
      input, encoding: 'utf8', windowsHide: true, timeout: 120_000,
      stdio: name === 'pg_ctl' ? 'ignore' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, PGCLIENTENCODING: 'UTF8' },
    });
    transcript.push({ tool: name, exitCode: result.status, expectedFailure: expectFailure, stdout: result.stdout || '', stderr: result.stderr || '' });
    if (result.error || (expectFailure ? result.status === 0 : result.status !== 0)) {
      throw new Error(`${name} ${expectFailure ? 'did not reject the negative test' : 'failed'}: ${result.error?.message || result.stderr}`);
    }
    return (result.stdout || '').trim();
  };
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let success = false;
  try {
    exec('initdb', ['-D', data, '-U', 'postgres_bootstrap', '--auth=trust', '--locale=C', '--encoding=UTF8']);
    started = true;
    exec('pg_ctl', ['-D', data, '-l', path.join(work, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    const connection = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres_bootstrap'];
    const sql = (text, fail = false, database = 'chi_shen_me', extra = []) => exec('psql', [...connection, '-d', database, ...extra], text, fail);
    const roles = ['schema_migrator', 'api_runtime', 'retention_worker', 'admin_api_runtime', 'data_export_worker'];
    sql(`${roles.map(role => `CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`).join('\n')}\nGRANT schema_migrator TO postgres_bootstrap;\nCREATE DATABASE chi_shen_me OWNER schema_migrator;`, false, 'postgres');
    sql('ALTER SCHEMA public OWNER TO schema_migrator;');
    const variables = ['-v', 'migration_owner=schema_migrator', '-v', 'runtime_role=api_runtime', '-v', 'maintenance_role=retention_worker', '-v', 'admin_runtime_role=admin_api_runtime', '-v', 'export_worker_role=data_export_worker'];
    const read = relative => fs.readFileSync(path.join(candidate, relative), 'utf8');
    sql(read('infra/postgres/bootstrap-extensions.sql'), false, 'chi_shen_me', variables);
    sql(`SET ROLE schema_migrator; CREATE TABLE public.schema_migrations (version integer PRIMARY KEY CHECK(version > 0), name varchar(120) NOT NULL, checksum varchar(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`);
    const migrationDirectory = path.join(candidate, 'apps/api/migrations');
    const migrations = fs.readdirSync(migrationDirectory).sort();
    const applyMigration = name => {
      const contents = fs.readFileSync(path.join(migrationDirectory, name));
      const version = Number(name.slice(0, 4));
      const label = name.slice(5, -4);
      const hash = crypto.createHash('sha256').update(contents).digest('hex');
      sql(`BEGIN; SET LOCAL ROLE schema_migrator;\n${contents.toString('utf8')}\nINSERT INTO public.schema_migrations(version,name,checksum) VALUES(${version},'${label}','${hash}'); COMMIT;`);
    };
    for (const name of migrations.slice(0, 16)) applyMigration(name);
    const grants = () => sql(`SET ROLE schema_migrator;\n${read('infra/postgres/role-grants.sql')}`, false, 'chi_shen_me', variables);
    const audits = ['verify-admin-config-control.sql', 'verify-wechat-miniprogram-login.sql', 'verify-canteen-public-ratings.sql'];
    grants();
    for (const name of audits) sql(read(`infra/postgres/${name}`));
    const aclQuery = `SELECT jsonb_build_object('tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relacl) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner='schema_migrator'::regrole),'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner='schema_migrator'::regrole));`;
    const beforeAcl = sql(aclQuery);
    const user = '20000000-0000-4000-8000-000000000001';
    const insertSession = platform => `INSERT INTO public.auth_session_families(user_id,device_label,platform,device_hash,hash_key_version,refresh_expires_at,retain_until) VALUES('${user}','Synthetic browser test','${platform}',repeat('a',64),'test.v1',now()+interval '1 hour',now()+interval '2 hours');`;
    sql(`SET ROLE schema_migrator; INSERT INTO public.users(id) VALUES('${user}');`);
    for (const platform of ['ANDROID', 'IOS', 'MINIPROGRAM']) sql(`SET ROLE api_runtime; ${insertSession(platform)}`);
    sql(`SET ROLE api_runtime; ${insertSession('WEB')}`, true);
    applyMigration(migrations[16]);
    grants();
    for (const name of [...audits, 'verify-web-browser-sessions.sql']) sql(read(`infra/postgres/${name}`));
    if (sql(aclQuery) !== beforeAcl) throw new Error('Schema 0017 changed existing object ACLs');
    sql(`SET ROLE api_runtime; ${insertSession('WEB')}`);
    sql(`SET ROLE api_runtime; ${insertSession('UNKNOWN')}`, true);
    if (sql(`SELECT count(*) FROM public.auth_session_families WHERE user_id='${user}';`) !== '4') throw new Error('Session rows were not preserved');
    const repository = read('apps/api/src/auth/auth.repository.ts');
    const match = repository.match(/`(SELECT id, device_label, platform, created_at, last_seen_at,[\s\S]*?LIMIT 50)`/);
    if (!match) throw new Error('Cannot locate the reviewed session-list SQL');
    const scenarios = [[false, false, '{ANDROID}'], [true, false, '{ANDROID,MINIPROGRAM}'], [true, true, '{ANDROID,MINIPROGRAM,WEB}']];
    for (const [all, web, expected] of scenarios) {
      const query = match[1].replaceAll('$1', `'${user}'::uuid`).replaceAll('$2', `'${user}'::uuid`).replaceAll('$3', String(all)).replaceAll('$4', String(web));
      const result = sql(`SET ROLE api_runtime; SELECT array_agg(platform ORDER BY platform) FROM (${query}) AS sessions;`);
      if (result !== expected) throw new Error(`Session negotiation differs for ${all}/${web}`);
    }
    // Reject unsupported/future heads rather than treating every later schema as compatible.
    sql("UPDATE public.schema_migrations SET name='unexpected_future' WHERE version=17;");
    for (const name of [...audits, 'verify-web-browser-sessions.sql']) sql(read(`infra/postgres/${name}`), true);
    sql(`SET ROLE schema_migrator;\n${read('infra/postgres/role-grants.sql')}`, true, 'chi_shen_me', variables);
    sql("UPDATE public.schema_migrations SET name='web_browser_sessions' WHERE version=17;");
    for (const name of [...audits, 'verify-web-browser-sessions.sql']) sql(read(`infra/postgres/${name}`));
    success = true;
    fs.writeFileSync(path.join(work, 'result.json'), `${JSON.stringify({ passed: true, migrationCount: 17, aclUnchanged: true, legacySessionsPreserved: true, webSessionInserted: true, invalidPlatformRejected: true, legacyAllExcludesWeb: true, allWithWebIncludesWeb: true, invalidLedgerRejectedByAllGates: true }, null, 2)}\n`);
    console.log(JSON.stringify({ passed: true, evidence: path.join(work, 'result.json') }));
  } finally {
    if (started) exec('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    fs.writeFileSync(path.join(work, 'transcript.json'), `${JSON.stringify({ passed: success, operations: transcript }, null, 2)}\n`);
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
