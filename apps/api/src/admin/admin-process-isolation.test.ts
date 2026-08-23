import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const APP_MODULE_PATH = new URL("../app.module.ts", import.meta.url);
const PUBLIC_MAIN_PATH = new URL("../main.ts", import.meta.url);
const ADMIN_APP_MODULE_PATH = new URL("./admin-app.module.ts", import.meta.url);
const ADMIN_MAIN_PATH = new URL("./admin-main.ts", import.meta.url);
const DOCKERFILE_PATH = new URL("../../Dockerfile", import.meta.url);
const COMPOSE_PATH = new URL(
	"../../../../infra/docker-compose.yml",
	import.meta.url,
);

describe("administrator process and container isolation", () => {
	it("keeps the public Nest graph and bootstrap free of administrator modules", async () => {
		const [appModule, main] = await Promise.all([
			readFile(APP_MODULE_PATH, "utf8"),
			readFile(PUBLIC_MAIN_PATH, "utf8"),
		]);
		expect(appModule).not.toMatch(/AdminModule|ADMIN_PROCESS_CONFIG/u);
		expect(main).not.toMatch(/AdminAppModule|admin-main|ADMIN_PROCESS_CONFIG/u);
		expect(main).toContain("AppModule");
	});

	it("boots administrator controllers only from the dedicated entrypoint", async () => {
		const [appModule, main] = await Promise.all([
			readFile(ADMIN_APP_MODULE_PATH, "utf8"),
			readFile(ADMIN_MAIN_PATH, "utf8"),
		]);
		expect(appModule).toContain("AdminModule");
		expect(appModule).not.toMatch(/from "\.\.\/app\.module/u);
		expect(main).toContain("AdminAppModule");
		expect(main).not.toMatch(/from "\.\.\/app\.module/u);
	});

	it("ships distinct public and administrator image targets", async () => {
		const dockerfile = await readFile(DOCKERFILE_PATH, "utf8");
		expect(dockerfile).toContain("AS admin-runtime");
		expect(dockerfile).toContain('["node", "dist/admin/admin-main.js"]');
		expect(dockerfile).toContain("AS runtime");
		expect(dockerfile).toContain('["node", "dist/main.js"]');
	});

	it("injects administrator secrets only into the isolated Compose service", async () => {
		const compose = (await readFile(COMPOSE_PATH, "utf8")).replaceAll(
			"\r\n",
			"\n",
		);
		const publicService = compose
			.split("\n  api:\n")[1]
			?.split("\n  admin-api:\n")[0];
		const adminService = compose
			.split("\n  admin-api:\n")[1]
			?.split("\n  admin:\n")[0];
		expect(publicService).toBeDefined();
		expect(publicService).toContain('ADMIN_API_ENABLED: "false"');
		expect(publicService).not.toMatch(
			/ADMIN_(?:DATABASE_URL|HMAC_KEYS|CREDENTIAL_ENCRYPTION_KEYS):/u,
		);
		expect(adminService).toContain("target: admin-runtime");
		expect(adminService).toContain('ADMIN_API_ENABLED: "true"');
		expect(adminService).toContain("ADMIN_DATABASE_URL:");
		expect(adminService).toContain("ADMIN_HMAC_KEYS:");
		expect(adminService).toContain("networks:\n      - admin_private");
		expect(adminService).not.toMatch(/\n\s+DATABASE_URL:/u);
	});
});
