import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
const appConfig = JSON.parse(readFileSync(join(output, "app.json"), "utf8"));
const template = JSON.parse(readFileSync(join(root, "project.config.example.json"), "utf8"));
assert.equal(template.miniprogramRoot, "dist/");
assert.equal(template.setting.urlCheck, true);
const modules = new Map();
let registeredApp;
let registeredPage;
const storage = new Map();
const runtime = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  hideShareMenu: () => {},
};
const sandbox = vm.createContext({
  wx: runtime,
  App: (app) => { registeredApp = app; },
  Page: (page) => { registeredPage = page; },
  getApp: () => registeredApp,
  getCurrentPages: () => [],
  setTimeout, clearTimeout,
});
function load(path) {
  const fullPath = resolve(path);
  assert.ok(fullPath.startsWith(`${output}\\`) || fullPath.startsWith(`${output}/`));
  if (modules.has(fullPath)) return modules.get(fullPath).exports;
  const module = { exports: {} };
  modules.set(fullPath, module);
  const source = readFileSync(fullPath, "utf8");
  const factory = new vm.Script(`(function(require,module,exports){${source}\n})`, { filename: fullPath }).runInContext(sandbox);
  factory((name) => {
    assert.ok(name.startsWith("."), `Unexpected external dependency: ${name}`);
    return load(resolve(dirname(fullPath), `${name}.js`));
  }, module, module.exports);
  return module.exports;
}
load(join(output, "app.js"));
assert.ok(registeredApp?.globalData);
registeredApp.onShow(); // With no consent, this must not call any network API.
for (const route of appConfig.pages) {
  assert.match(route, /^pages\/[a-z-]+\/index$/);
  for (const extension of [".js", ".json", ".wxml", ".wxss"]) {
    assert.ok(statSync(join(output, route + extension)).size > 0);
  }
  registeredPage = undefined;
  load(join(output, `${route}.js`));
  assert.ok(registeredPage, `Page did not register: ${route}`);
  const templateSource = readFileSync(join(output, `${route}.wxml`), "utf8");
  for (const match of templateSource.matchAll(/(?:bind|catch)(?::)?[a-z]+="([A-Za-z][A-Za-z0-9]*)"/g)) {
    assert.equal(typeof registeredPage[match[1]], "function", `${route}: missing ${match[1]}`);
  }
}
let size = 0;
function checkFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkFiles(path);
    else {
      assert.ok(!entry.name.includes(".test.") && extname(path) !== ".ts", `Test/source shipped: ${path}`);
      size += statSync(path).size;
    }
  }
}
checkFiles(output);
assert.ok(size < 2 * 1024 * 1024, "Main package exceeds local 2 MiB budget");
console.log(`Package smoke passed: ${appConfig.pages.length} routes, ${size} bytes; no network before consent.`);
