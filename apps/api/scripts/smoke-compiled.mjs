import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = resolve(packageRoot, "dist/main.js");
const adminModuleEntrypoint = resolve(
	packageRoot,
	"dist/admin/admin-app.module.js",
);

// Import the dedicated administrator graph without bootstrapping a listener or
// reading ADMIN_* secrets. This catches missing production dependencies and ESM
// drift while keeping the runtime smoke independent of a real PostgreSQL server.
const { AdminAppModule } = await import(
	pathToFileURL(adminModuleEntrypoint).href
);
if (typeof AdminAppModule !== "function") {
	throw new Error("Compiled administrator module could not be loaded");
}

function minimalSystemEnvironment() {
	const environment = {};
	for (const key of [
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
	]) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

function reserveEphemeralPort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a local smoke-test port"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolvePort(port)));
		});
	});
}

async function waitForHealth(baseUrl, child) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`Compiled API exited before readiness (code ${child.exitCode})`,
			);
		}
		try {
			const response = await fetch(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(750),
			});
			if (response.status === 200) return response;
		} catch {
			// Startup races are expected until the local listener is ready.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error("Compiled API did not become healthy within 10 seconds");
}

async function requireJson(response, expectedStatus, label) {
	if (response.status !== expectedStatus) {
		throw new Error(`${label} returned HTTP ${response.status}`);
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		throw new Error(`${label} did not return application/json`);
	}
	return response.json();
}

async function stopChild(child) {
	if (child.exitCode !== null) return;
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	child.kill("SIGTERM");
	const stopped = await Promise.race([
		exited.then(() => true),
		new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2_000)),
	]);
	if (!stopped && child.exitCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
}

const port = await reserveEphemeralPort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [entrypoint], {
	cwd: packageRoot,
	env: {
		...minimalSystemEnvironment(),
		NODE_ENV: "development",
		PORT: String(port),
		TRUSTED_PROXY_CIDRS: "",
		DATA_RIGHTS_MODE: "LIVE_DISPLAY_ONLY",
		ALLOW_DEMO_DATA: "true",
		AMAP_ENABLED: "false",
		AMAP_WEB_SERVICE_KEY: "",
		QWEN_ENABLED: "false",
		QWEN_BASE_URL: "",
		QWEN_API_KEY: "",
	},
	stdio: "ignore",
	windowsHide: true,
});

try {
	const health = await requireJson(
		await waitForHealth(baseUrl, child),
		200,
		"/health",
	);
	if (health.status !== "ok")
		throw new Error("/health did not report status=ok");
	const readiness = await requireJson(
		await fetch(`${baseUrl}/health/ready`, {
			signal: AbortSignal.timeout(2_000),
		}),
		200,
		"/health/ready",
	);
	if (readiness.status !== "ready") {
		throw new Error("/health/ready did not report status=ready");
	}

	const config = await requireJson(
		await fetch(`${baseUrl}/v1/config`, { signal: AbortSignal.timeout(2_000) }),
		200,
		"/v1/config",
	);
	if (config.dataRightsMode !== "LIVE_DISPLAY_ONLY") {
		throw new Error("/v1/config returned an unexpected data-rights mode");
	}
	if (
		config.serviceCapabilities?.recommendationsEnabled !== true ||
		config.serviceCapabilities.locationSearchEnabled !== true ||
		config.serviceCapabilities.placeSearchEnabled !== true
	) {
		throw new Error("/v1/config did not advertise demo service capabilities");
	}

	const locations = await requireJson(
		await fetch(`${baseUrl}/v1/location-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "北京大学东门" }),
			signal: AbortSignal.timeout(2_000),
		}),
		200,
		"/v1/location-search",
	);
	if (locations.dataSource !== "DEMO" || !Array.isArray(locations.results)) {
		throw new Error("/v1/location-search did not use deterministic demo data");
	}
	if (locations.results.length === 0) {
		throw new Error(
			"/v1/location-search returned no deterministic demo result",
		);
	}

	const shanghaiLocation = {
		latitude: 31.2304,
		longitude: 121.4737,
		crs: "WGS84",
	};
	const recommendations = await requireJson(
		await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: shanghaiLocation,
				mealPeriod: "LUNCH",
				radiusMeters: 1_500,
			}),
			signal: AbortSignal.timeout(2_000),
		}),
		200,
		"/v1/recommendations",
	);
	if (
		recommendations.coverage !== "NATIONWIDE" ||
		!Array.isArray(recommendations.results) ||
		recommendations.results.length === 0
	) {
		throw new Error(
			"/v1/recommendations did not cover the Shanghai nationwide smoke origin",
		);
	}

	const places = await requireJson(
		await fetch(`${baseUrl}/v1/place-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: shanghaiLocation,
				mealPeriod: "LUNCH",
				keyword: "牛肉面",
				radiusMeters: 1_500,
				openNow: false,
				limit: 3,
			}),
			signal: AbortSignal.timeout(2_000),
		}),
		200,
		"/v1/place-search",
	);
	if (
		places.coverage !== "NATIONWIDE" ||
		!Array.isArray(places.results) ||
		places.results.length === 0
	) {
		throw new Error(
			"/v1/place-search did not cover the Shanghai nationwide smoke origin",
		);
	}

	console.log(
		`Compiled API smoke passed on an ephemeral local port: /health 200, /health/ready 200, /v1/config 200, /v1/location-search DEMO 200, Shanghai /v1/recommendations NATIONWIDE 200, Shanghai /v1/place-search NATIONWIDE 200.`,
	);
} finally {
	await stopChild(child);
}
