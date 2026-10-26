// Only app-generated deletion targets are journaled, never selector originals,
// image bytes, candidates or receipts. A native tmp file is moved only when the
// platform refuses unlink, and its destination is recorded before that move.
const MAX_ENTRIES = 24;
const RECOVERY_KEY = 'eatwhat.wechat.takeout-cleanup-targets.v1';
const TARGET_PREFIX = 'eatwhat-takeout-cleanup-';
const CLEANUP_MESSAGE = '部分截图临时副本清理尚未确认，请重试清理。原相册图片未改动。';
function failure() { const error = new Error('截图临时副本尚未清理，请先清理临时副本后重试。'); error.code = 'CLEANUP_REQUIRED'; return error; }
function missing(error) { return /ENOENT|no such file|file not exist/i.test(typeof error?.errMsg === 'string' ? error.errMsg : ''); }
function permissionDenied(error) { return /permission denied|EACCES|EPERM/i.test(typeof error?.errMsg === 'string' ? error.errMsg : ''); }
function nativeTemporary(path) {
  return typeof path === 'string' && /^(?:https?:\/\/tmp\/|wxfile:\/\/tmp(?:\/|_))[^?#\\]+$/i.test(path) &&
    !path.includes('/../') && !path.endsWith('/..');
}
function invoke(start) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const success = value => { if (!settled) { settled = true; resolve(value); } };
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    try { start({ success, fail }); } catch (error) { fail(error); }
  });
}
function createCleanupRegistry(options = {}) {
  const entries = new Map(), paths = new Map();
  let runtime = options.runtime || null, fileSystem = options.fs || null, recoveryError = false, nextTarget = 0;
  function platform() { return runtime || (typeof wx === 'undefined' ? null : wx); }
  function rootPath() {
    const value = platform()?.env?.USER_DATA_PATH;
    if (typeof value !== 'string' || !value || value.length > 1800 || /[?#\\]/.test(value) ||
      value.includes('/../') || value.endsWith('/..') || [...value].some(character => character.charCodeAt(0) < 32)) throw failure();
    return value.replace(/\/$/, '');
  }
  function validTarget(path) {
    if (typeof path !== 'string') return false;
    const prefix = `${rootPath()}/${TARGET_PREFIX}`;
    return path.startsWith(prefix) && /^[a-z0-9]{1,24}-[a-z0-9]{1,24}-[a-z0-9]{1,24}\.tmp$/.test(path.slice(prefix.length));
  }
  function readTargets() {
    const api = platform();
    if (typeof api?.getStorageSync !== 'function') return [];
    const value = api.getStorageSync(RECOVERY_KEY);
    if (value === undefined || value === null || value === '') return [];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      value.version !== 1 || !Array.isArray(value.targets) || value.targets.length > MAX_ENTRIES ||
      new Set(value.targets).size !== value.targets.length || !value.targets.every(validTarget)) throw failure();
    return [...value.targets];
  }
  function writeTargets(targets) {
    const api = platform();
    if (typeof api?.setStorageSync !== 'function' || typeof api.getStorageSync !== 'function' ||
      targets.length > MAX_ENTRIES || new Set(targets).size !== targets.length || !targets.every(validTarget)) throw failure();
    const value = { version: 1, targets: [...targets].sort() };
    api.setStorageSync(RECOVERY_KEY, value);
    if (JSON.stringify(readTargets().sort()) !== JSON.stringify(value.targets)) throw failure();
  }
  function addTarget(path) {
    const targets = readTargets();
    if (!targets.includes(path)) targets.push(path);
    // Always persist and read back immediately before a native move, including
    // retries after a previous uncertain storage write.
    writeTargets(targets);
  }
  function forgetTarget(path) {
    if (!path) return;
    const targets = readTargets();
    if (targets.includes(path)) writeTargets(targets.filter(value => value !== path));
  }
  function system() {
    if (!fileSystem) {
      const api = platform();
      if (typeof api?.getFileSystemManager !== 'function') throw failure();
      fileSystem = api.getFileSystemManager();
    }
    if (typeof fileSystem?.unlink !== 'function' || typeof fileSystem.access !== 'function') throw failure();
    return fileSystem;
  }
  function recover() {
    try {
      const targets = readTargets();
      for (const target of targets) {
        if ([...entries.values()].some(entry => entry.target === target || entry.path === target)) continue;
        if (entries.size >= MAX_ENTRIES) throw failure();
        const fs = system(), ticket = {};
        entries.set(ticket, { path: target, target, remove: fs.unlink.bind(fs), fs,
          allowMove: false, recovered: true, task: null, state: 'ready' });
        paths.set(target, ticket);
      }
      recoveryError = false;
    } catch (_) { recoveryError = true; throw failure(); }
  }
  function reserve(remove, policy = {}) {
    if (policy.runtime) runtime = policy.runtime;
    if (policy.fs) fileSystem = policy.fs;
    recover();
    if (entries.size >= MAX_ENTRIES || typeof remove !== 'function') throw failure();
    const ticket = {};
    entries.set(ticket, { path: null, target: null, remove, fs: policy.fs || null,
      allowMove: policy.allowMove === true, recovered: false, task: null, state: 'creating' });
    return ticket;
  }
  function abandon(ticket) {
    const entry = entries.get(ticket);
    if (entry && entry.path === null) entries.delete(ticket);
  }
  function commit(ticket, path) {
    const entry = entries.get(ticket);
    if (!entry || typeof path !== 'string' || !path) throw failure();
    const existingTicket = paths.get(path);
    if (existingTicket && existingTicket !== ticket) {
      const existing = entries.get(existingTicket);
      abandon(ticket);
      // Native filenames cannot be reused while their previous deletion runs.
      if (existing?.task) throw failure();
      return existingTicket;
    }
    entry.path = path; entry.state = 'ready'; paths.set(path, ticket);
    return ticket;
  }
  async function absent(fs, path) {
    try { await invoke(callbacks => fs.access({ path, ...callbacks })); return false; }
    catch (error) { if (missing(error)) return true; throw failure(); }
  }
  async function unlink(entry, path, managed = false) {
    const remove = managed ? entry.fs.unlink.bind(entry.fs) : entry.remove;
    try { await invoke(callbacks => remove({ filePath: path, ...callbacks })); }
    catch (error) { if (!missing(error)) throw error; }
    if (typeof entry.fs?.access === 'function' && !await absent(entry.fs, path)) throw failure();
  }
  async function allocateTarget(entry) {
    const api = platform();
    if (!entry.fs || typeof entry.fs.saveFileSync !== 'function' || typeof entry.fs.access !== 'function' ||
      typeof api?.setStorageSync !== 'function' || typeof api.getStorageSync !== 'function') throw failure();
    const root = rootPath();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const suffix = `${Date.now().toString(36)}-${(++nextTarget).toString(36)}-${Math.random().toString(36).slice(2, 14) || '0'}`;
      const target = `${root}/${TARGET_PREFIX}${suffix}.tmp`;
      if (!validTarget(target) || readTargets().includes(target) || !await absent(entry.fs, target)) continue;
      return target;
    }
    throw failure();
  }
  async function erase(entry) {
    if (entry.recovered) {
      await unlink(entry, entry.target, true);
      forgetTarget(entry.target);
      return;
    }
    // A move may create its target before throwing an error. Remove that recorded destination first, never lose its identity.
    if (entry.target) await unlink(entry, entry.target, true);
    try {
      await unlink(entry, entry.path);
      forgetTarget(entry.target);
      return;
    } catch (error) {
      if (!entry.allowMove || !nativeTemporary(entry.path) || !permissionDenied(error)) throw error;
    }
    if (!entry.target) entry.target = await allocateTarget(entry);
    addTarget(entry.target);
    // Do not leave native creation pending after this JS context can disappear.
    // Write-ahead metadata and the synchronous move share one JS turn; only
    // subsequent verification/deletion is asynchronous and safe to retry.
    const savedPath = entry.fs.saveFileSync(entry.path, entry.target);
    if (savedPath !== entry.target) throw failure();
    if (!await absent(entry.fs, entry.path)) throw failure();
    await unlink(entry, entry.target, true);
    forgetTarget(entry.target);
  }
  function remove(path) {
    const ticket = paths.get(path), entry = entries.get(ticket);
    if (!entry) return Promise.resolve(true);
    if (entry.task) return entry.task;
    let complete;
    const task = new Promise(resolve => { complete = resolve; });
    entry.task = task; entry.state = 'deleting';
    let settled = false;
    const finish = (success, nativeFinished) => {
      if (nativeFinished) {
        if (success) { paths.delete(path); entries.delete(ticket); }
        else { entry.task = null; entry.state = 'failed'; }
      } else entry.state = 'uncertain';
      if (settled) return;
      settled = true; clearTimeout(timer); complete(success);
    };
    // Timeout reports uncertainty but retains the lock. A late native deletion
    // still owns its cleanup and cannot be duplicated by a retry.
    const timer = setTimeout(() => finish(false, false), 3000);
    erase(entry).then(() => finish(true, true), () => finish(false, true));
    return task;
  }
  async function clearAll() {
    try { recover(); } catch (_) { /* Known in-process files can still be removed. */ }
    const attempted = new Set(entries.keys());
    const results = await Promise.all([...entries.values()].map(entry => entry.path === null ? Promise.resolve(false) : remove(entry.path)));
    // Freed slots may now admit recovery records that were initially blocked.
    try { recover(); } catch (_) { /* The false result retains the visible cleanup failure. */ }
    const recovered = [...entries].filter(([ticket]) => !attempted.has(ticket));
    results.push(...await Promise.all(recovered.map(([, entry]) => remove(entry.path))));
    if (recoveryError) results.push(false);
    return results;
  }
  function state() {
    try { recover(); } catch (_) { /* Surface corrupt/unreadable recovery metadata without deleting it. */ }
    return { count: entries.size, failed: [...entries.values()].filter(entry => ['failed', 'uncertain'].includes(entry.state)).length + (recoveryError ? 1 : 0),
      creating: [...entries.values()].filter(entry => entry.state === 'creating').length, capacityReached: entries.size >= MAX_ENTRIES || recoveryError };
  }
  return { reserve, commit, abandon, remove, clearAll, state };
}
module.exports = { ...createCleanupRegistry(), createCleanupRegistry, MAX_ENTRIES, RECOVERY_KEY, CLEANUP_MESSAGE };
