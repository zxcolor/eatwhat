import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { WECHAT_LOGIN_ENABLED } from "./features";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_EXTENSIONS = new Set([".ts", ".json", ".wxml", ".wxss"]);

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
	});
}

describe("mini-program source credential boundary", () => {
	it("registers every product page without adding a QQ route", () => {
		const appConfig = JSON.parse(
			readFileSync(resolve(APP_ROOT, "src/app.json"), "utf8"),
		) as { readonly pages: readonly string[] };
		expect(appConfig.pages).toEqual([
			"pages/consent/index",
			"pages/home/index",
			"pages/results/index",
			"pages/detail/index",
			"pages/login/index",
			"pages/account/index",
			"pages/saved/index",
			"pages/feedback/index",
			"pages/settings/index",
			"pages/update/index",
		]);
		expect(
			appConfig.pages.some((page) => page.toLowerCase().includes("qq")),
		).toBe(false);
		for (const page of appConfig.pages) {
			for (const extension of [".ts", ".json", ".wxml", ".wxss"]) {
				expect(
					readFileSync(resolve(APP_ROOT, `src/${page}${extension}`), "utf8"),
				).not.toHaveLength(0);
			}
		}
	});

	it("ships only an AppID template and no real WeChat AppID or AppSecret", () => {
		const projectTemplate = JSON.parse(
			readFileSync(resolve(APP_ROOT, "project.config.example.json"), "utf8"),
		) as Record<string, unknown>;
		expect(projectTemplate.appid).toBe("wx_REPLACE_WITH_LOCAL_APP_ID");
		expect(
			Object.keys(projectTemplate).map((key) => key.toLowerCase()),
		).not.toContain("appsecret");

		const sources = sourceFiles(resolve(APP_ROOT, "src"))
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");
		expect(sources).not.toMatch(/\bwx[0-9a-f]{16}\b/iu);
		expect(sources).not.toMatch(/\bapp_?secret\b\s*[:=]/iu);

		const gitignore = readFileSync(
			resolve(APP_ROOT, "../../.gitignore"),
			"utf8",
		);
		expect(gitignore).toContain("apps/miniprogram/project.config.json");
	});

	it("keeps WeChat login disabled by a non-runtime feature flag", () => {
		expect(WECHAT_LOGIN_ENABLED).toBe(false);
	});
});
