#!/usr/bin/env python3
"""Prepare immutable WEB/recovery releases only; never migrate or activate."""
from __future__ import print_function
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(path):
    with open(path, 'rb') as stream:
        return stream.read()


def write_new(path, data):
    with open(path, 'xb') as stream:
        stream.write(data)
    os.chmod(path, 0o600)


def main():
    require(os.geteuid() == 0, 'Preparation requires root')
    require(len(sys.argv) == 3, 'Pass upload directory and expected plan SHA-256')
    upload, plan_sha = sys.argv[1:]
    require(re.match(r'^/root/\.eatwhat-web-[0-9a-f]{12}-upload$', upload), 'Unexpected upload directory')
    require(os.path.realpath(upload) == upload and not os.path.islink(upload), 'Unsafe upload directory')
    require(re.match(r'^[0-9a-f]{64}$', plan_sha), 'Invalid plan digest')
    os.umask(0o077)
    plan_bytes = read(os.path.join(upload, 'preparation-plan.json'))
    require(digest(plan_bytes) == plan_sha, 'Preparation plan hash mismatch')
    plan = json.loads(plan_bytes.decode('utf-8'))
    require(plan['formatVersion'] == 1, 'Unsupported plan format')
    require(re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', plan['baselineRelease']), 'Unsafe baseline release')
    require(re.match(r'^sha256:[0-9a-f]{64}$', plan['baselineImage']), 'Unsafe base image')
    require(re.match(r'^chi-shen-me-api:[a-zA-Z0-9._-]+$', plan['baselineTag']), 'Unsafe base tag')
    active = '/opt/chi-shen-me/releases/' + plan['baselineRelease']
    active_env = active + '/deploy/deployment.env'
    events = []

    def command(argv, stage, data=None, env=None):
        result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        write_new(os.path.join(upload, stage + '.log'), result.stdout + result.stderr)
        events.append({'stage': stage, 'exitCode': result.returncode})
        require(result.returncode == 0, stage + ' failed; inspect the root-only preparation log')
        return result.stdout

    def inspect(image):
        return json.loads(subprocess.check_output(['docker', 'image', 'inspect', image]))[0]

    def baseline_check():
        require(os.path.islink('/opt/chi-shen-me/current'), 'Active release is not a symlink')
        require(os.path.realpath('/opt/chi-shen-me/current') == active, 'Active release changed; stop preparation')
        api = json.loads(subprocess.check_output(['docker', 'inspect', 'chi-shen-me-alpha-api-1']))[0]
        postgres = json.loads(subprocess.check_output(['docker', 'inspect', 'chi-shen-me-alpha-postgres-1']))[0]
        require(api['Image'] == plan['baselineImage'] and api['State']['Health']['Status'] == 'healthy', 'Active API baseline changed')
        require(postgres['Id'] == plan['expectedPostgres'] and postgres['State']['Health']['Status'] == 'healthy', 'PostgreSQL baseline changed')
        require(digest(read(active_env)) == plan['expectedActiveEnvSha256'], 'Active environment changed')
        require(inspect(plan['baselineTag'])['Id'] == plan['baselineImage'], 'Base image tag no longer matches its immutable ID')

    lock_path = '/run/lock/chi-shen-me/mutation.lock'
    lock_stat = os.lstat(lock_path)
    require(stat.S_ISREG(lock_stat.st_mode) and lock_stat.st_uid == 0 and stat.S_IMODE(lock_stat.st_mode) == 0o600, 'Unsafe deployment lock')
    with open(lock_path, 'r+') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        baseline_check()
        base_image = inspect(plan['baselineImage'])
        disk = os.statvfs('/opt/chi-shen-me')
        require(disk.f_bavail * disk.f_frsize >= 512 * 1024 * 1024, 'Insufficient space; no cache or release may be deleted automatically')
        archives = {item['name']: item for item in plan['archives']}
        for item in archives.values():
            require(re.match(r'^(web|recovery)-(source|overlay)\.tar\.gz$|^deploy\.tar\.gz$', item['name']), 'Unsafe archive name')
            contents = read(os.path.join(upload, item['name']))
            require(len(contents) == item['bytes'] and digest(contents) == item['sha256'], 'Archive hash mismatch')
            with tarfile.open(os.path.join(upload, item['name']), 'r:gz') as archive:
                members = archive.getmembers()
                require(len(members) == len(item['members']), 'Archive member count mismatch')
                require(set(member.name for member in members) == set(item['members']), 'Archive membership mismatch')
                require(len(set(member.name for member in members)) == len(members), 'Duplicate archive member')
                for member in members:
                    require(member.isfile() and not member.name.startswith('/') and '..' not in member.name.split('/'), 'Unsafe archive member')

        def extract(name, destination):
            require(not os.path.exists(destination), 'Never overwrite an existing release directory')
            os.mkdir(destination, 0o700)
            with tarfile.open(os.path.join(upload, name), 'r:gz') as archive:
                for member in archive.getmembers():
                    target = os.path.join(destination, member.name)
                    require(os.path.commonpath([destination, os.path.realpath(target)]) == destination, 'Archive target escapes release')
                    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                    write_new(target, archive.extractfile(member).read())

        docker_config = os.path.join(upload, 'docker-config')
        os.mkdir(docker_config, 0o700)
        write_new(os.path.join(docker_config, 'config.json'), b'{}\n')
        build_env = dict(os.environ, DOCKER_CONFIG=docker_config, DOCKER_BUILDKIT='0')
        runtime_script = b"""const fs=require('fs'),path=require('path'),crypto=require('crypto');const files=[];
for(const [label,root] of [['api','/app/dist'],['contracts','/app/node_modules/@chi-shen-me/contracts/dist'],['migrations','/app/migrations']]){function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const target=path.join(dir,entry.name);if(entry.isDirectory())walk(target);else if(entry.isFile()){const bytes=fs.readFileSync(target);files.push({path:label+'/'+path.relative(root,target),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})}else throw Error('Unexpected runtime link')}}walk(root)}console.log(JSON.stringify(files));"""
        prepared = []
        for entry in plan['entries']:
            mode = entry['mode']
            require(mode in ('web', 'recovery'), 'Unexpected mode')
            require(re.match(r'^20261026-web(?:-recovery)?-[0-9a-f]{12}$', entry['release']), 'Unsafe new release name')
            require(entry['imageTag'] == 'chi-shen-me-api:' + entry['release'], 'Image tag does not match release')
            release = '/opt/chi-shen-me/releases/' + entry['release']
            require(not os.path.lexists(release), 'Release already exists; inspect instead of overwriting')
            require(subprocess.run(['docker', 'image', 'inspect', entry['imageTag']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0, 'Candidate image tag already exists')
            os.mkdir(release, 0o700)
            extract(mode + '-source.tar.gz', release + '/source')
            extract('deploy.tar.gz', release + '/deploy')
            overlay = os.path.join(upload, mode + '-build')
            extract(mode + '-overlay.tar.gz', overlay)
            dockerfile = read(os.path.join(overlay, 'Dockerfile')).decode('utf-8')
            require(dockerfile.startswith('FROM ' + plan['baselineTag'] + '\n'), 'Incremental image has an unexpected base')
            require(not re.search(r'^(RUN|ADD|CMD|ENTRYPOINT|ARG|ENV)\s', dockerfile, re.M), 'Incremental image may only copy reviewed files and labels')
            baseline_check()
            command(['docker', 'build', '--pull=false', '--network=none', '--memory=384m', '--memory-swap=512m', '--cpu-period=100000', '--cpu-quota=50000', '-t', entry['imageTag'], overlay], mode + '-build', env=build_env)
            built = inspect(entry['imageTag'])
            require(built['Architecture'] == 'amd64' and built['Os'] == 'linux' and built['Config']['User'] == 'node', 'Wrong image execution boundary')
            require(built['Config']['Cmd'] == base_image['Config']['Cmd'] and built['Config'].get('Entrypoint') == base_image['Config'].get('Entrypoint'), 'Image entrypoint changed')
            old_layers = base_image['RootFS']['Layers']
            require(built['RootFS']['Layers'][:len(old_layers)] == old_layers, 'Candidate did not preserve every active image layer')
            observed = json.loads(command(['docker', 'run', '--rm', '-i', '--network=none', '--read-only', '--memory=128m', '--pids-limit=64', '--cap-drop=ALL', '--entrypoint=node', built['Id'], '-'], mode + '-runtime-manifest', runtime_script).decode('utf-8'))
            expected = {item['path']: item for item in plan['baseRuntime']}
            expected.update({item['path']: item for item in entry['overrides']})
            require(len(observed) == len(expected), 'Runtime membership changed outside the reviewed increment')
            for item in observed:
                require(item == expected.get(item['path']), 'Runtime file differs from the reviewed increment: ' + item['path'])
            smoke = """import {loadMigrationPlan} from './dist/database/migration-plan.js';import {AuthDeviceContextSchema,LoginRequestSchema,WechatMiniProgramLoginRequestSchema} from '@chi-shen-me/contracts';
const plan=await loadMigrationPlan();if(plan.length!==17||plan.at(-1).name!=='web_browser_sessions')throw Error('migration');
const device={installationId:'20000000-0000-4000-8000-000000000001',label:'Synthetic WEB image test',platform:'WEB',appVersion:'0.1.39-web'};
if(AuthDeviceContextSchema.safeParse(device).success!==EXPECTED_WEB)throw Error('web platform');
if(WechatMiniProgramLoginRequestSchema.safeParse({device,code:'synthetic-wechat-code'}).success)throw Error('mini boundary');
if(LoginRequestSchema.safeParse({method:'WECHAT',device,oauthState:'A'.repeat(43),authorizationCode:'synthetic-oauth-code'}).success)throw Error('native boundary');
console.log('IMAGE_SCHEMA_AND_PLATFORM_BOUNDARIES=OK');""".replace('EXPECTED_WEB', 'true' if mode == 'web' else 'false')
            command(['docker', 'run', '--rm', '--network=none', '--read-only', '--memory=128m', '--pids-limit=64', '--cap-drop=ALL', '--entrypoint=node', built['Id'], '--input-type=module', '-e', smoke], mode + '-image-smoke')
            env_before = read(active_env)
            env_lines = env_before.decode('utf-8').splitlines(True)
            replacements = {'API_IMAGE': entry['imageTag'], 'API_IMAGE_ID': built['Id']}
            for key, value in replacements.items():
                indexes = [i for i, line in enumerate(env_lines) if line.startswith(key + '=')]
                require(len(indexes) == 1, 'Missing or duplicate image setting')
                i = indexes[0]
                newline = '\r\n' if env_lines[i].endswith('\r\n') else '\n'
                env_lines[i] = key + '=' + value + newline
            env_after = ''.join(env_lines).encode('utf-8')
            filtered = lambda data: b''.join(line for line in data.splitlines(True) if not line.startswith((b'API_IMAGE=', b'API_IMAGE_ID=')))
            require(filtered(env_before) == filtered(env_after), 'Candidate environment changed outside image fields')
            write_new(release + '/deploy/deployment.env', env_after)
            command(['bash', release + '/deploy/scripts/harden-release-permissions.sh'], mode + '-harden')
            command(['bash', release + '/deploy/scripts/preflight-deployment.sh'], mode + '-preflight')
            baseline_check()
            record = {'mode': mode, 'release': release, 'imageId': built['Id'], 'imageTag': entry['imageTag'], 'imageBytes': built['Size'], 'preservedBaseLayers': len(old_layers), 'verifiedRuntimeFiles': len(observed), 'environmentOnlyImageFieldsChanged': True}
            prepared.append(record)
            write_new(release + '/web-preparation.json', (json.dumps(record, indent=2) + '\n').encode('utf-8'))
        web = next(item for item in prepared if item['mode'] == 'web')
        recovery = next(item for item in prepared if item['mode'] == 'recovery')
        command(['bash', web['release'] + '/deploy/scripts/verify-rollback-release.sh', recovery['release'], '--target-image', web['imageId']], 'recovery-target-image-check')
        baseline_check()
        receipt = {'preparedAtEpoch': int(time.time()), 'planSha256': plan_sha, 'baselineRelease': active, 'baselineImage': plan['baselineImage'], 'entries': prepared, 'events': events, 'currentUnchanged': True, 'postgresUnchanged': True, 'migrationPerformed': False, 'activationPerformed': False, 'nginxChanged': False}
        write_new(os.path.join(upload, 'preparation-receipt.json'), (json.dumps(receipt, indent=2) + '\n').encode('utf-8'))
        print(json.dumps(receipt))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('PREPARATION_FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
