import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { configureHttpRuntime } from "./http-runtime-security.js";

describe("HTTP runtime security", () => {
	it("explicitly disables trust proxy when no CIDR is configured", () => {
		const runtime = { disable: vi.fn(), set: vi.fn(), use: vi.fn() };
		const app = {
			getHttpAdapter: () => ({ getInstance: () => runtime }),
			useBodyParser: vi.fn(),
		};
		configureHttpRuntime(app, loadAppConfig({ NODE_ENV: "test" }));
		expect(runtime.disable).toHaveBeenCalledWith("x-powered-by");
		expect(runtime.set).toHaveBeenCalledWith("trust proxy", false);
		expect(app.useBodyParser).toHaveBeenCalledWith("json", {
			limit: 100 * 1_024,
		});
	});

	it("passes only the validated proxy network list to Express", () => {
		const runtime = { disable: vi.fn(), set: vi.fn(), use: vi.fn() };
		const app = {
			getHttpAdapter: () => ({ getInstance: () => runtime }),
			useBodyParser: vi.fn(),
		};
		configureHttpRuntime(
			app,
			loadAppConfig({
				NODE_ENV: "test",
				TRUSTED_PROXY_CIDRS: "10.0.0.0/8,2001:db8::/32",
			}),
		);
		expect(runtime.set).toHaveBeenCalledWith("trust proxy", [
			"10.0.0.0/8",
			"2001:db8::/32",
		]);
	});
});
