import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const tscPath = resolve(packageRoot, "node_modules/typescript/bin/tsc");
const contractsTscPath = resolve(
	workspaceRoot,
	"packages/contracts/node_modules/typescript/bin/tsc",
);

const children = new Set();
let stopping = false;

function compilerEnvironment() {
	const environment = {};
	for (const key of [
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"PATH",
		"Path",
		"PATHEXT",
		"APPDATA",
		"LOCALAPPDATA",
		"USERPROFILE",
	]) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

function start(label, command, args, cwd, environment) {
	const child = spawn(command, args, {
		cwd,
		env: environment,
		stdio: "inherit",
		windowsHide: true,
	});
	children.add(child);

	child.once("exit", (code, signal) => {
		children.delete(child);
		if (stopping) return;

		stopping = true;
		const reason =
			signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
		console.error(
			`[dev] ${label} stopped unexpectedly (${reason}); stopping all watchers.`,
		);
		stopChildren();
		process.exitCode = code === 0 ? 1 : (code ?? 1);
	});

	child.once("error", (error) => {
		if (stopping) return;
		stopping = true;
		console.error(
			`[dev] Could not start ${label}: ${error.code ?? "process error"}`,
		);
		stopChildren();
		process.exitCode = 1;
	});

	return child;
}

function stopChildren() {
	for (const child of children) {
		if (!child.killed) child.kill("SIGTERM");
	}
}

function handleShutdown() {
	if (stopping) return;
	stopping = true;
	stopChildren();
}

process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);
process.once("SIGHUP", handleShutdown);

console.log(
	"[dev] Running only TypeScript compiler output; Nest decorator metadata is preserved.",
);

start(
	"contracts compiler",
	process.execPath,
	[
		contractsTscPath,
		"-p",
		"tsconfig.build.json",
		"--watch",
		"--preserveWatchOutput",
	],
	resolve(workspaceRoot, "packages/contracts"),
	compilerEnvironment(),
);
start(
	"API compiler",
	process.execPath,
	[tscPath, "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"],
	packageRoot,
	compilerEnvironment(),
);
start(
	"API runtime",
	process.execPath,
	["--watch", "--watch-preserve-output", "dist/main.js"],
	packageRoot,
	process.env,
);

await new Promise((resolveShutdown) => {
	const poll = setInterval(() => {
		if (stopping && children.size === 0) {
			clearInterval(poll);
			resolveShutdown();
		}
	}, 25);
	poll.unref();
});
