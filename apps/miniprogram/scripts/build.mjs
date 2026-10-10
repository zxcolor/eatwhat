import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src");
const output = join(root, "dist");
// Only this generated directory is replaced. Never touch sources or credentials.
if (dirname(output) !== root || output === source) throw new Error("BUILD_PATH_INVALID");
rmSync(output, { recursive: true, force: true });
const compilerPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
const compiler = join(dirname(compilerPackage), "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json"], {
  cwd: root, stdio: "inherit", shell: false,
});
if (result.error || result.status !== 0) process.exit(result.status ?? 1);

function copyAssets(directory, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const from = join(directory, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyAssets(from, to);
    else if ([".json", ".wxml", ".wxss", ".svg", ".png"].includes(extname(entry.name))) copyFileSync(from, to);
  }
}
copyAssets(source, output);
const template = JSON.parse(readFileSync(join(root, "project.config.example.json"), "utf8"));
const localProject = join(root, "project.config.json");
if (!existsSync(localProject)) {
  // Tourist mode can import and inspect the build without a real AppID.
  writeFileSync(localProject, `${JSON.stringify({ ...template, appid: "touristappid" }, null, 2)}\n`);
}
console.log("Mini-program compiled to dist; existing local AppID configuration preserved.");
