import { isIP } from "node:net";
import type { NodeEnvironment } from "../database/database-config.js";
import {
	type AdminRuntimeConfig,
	loadAdminRuntimeConfig,
} from "./admin-config.js";

export const ADMIN_PROCESS_CONFIG = Symbol("ADMIN_PROCESS_CONFIG");

export interface AdminProcessConfig {
	readonly nodeEnv: NodeEnvironment;
	readonly port: number;
	readonly bindHost: string;
	readonly trustedProxyCidrs: readonly string[];
	readonly admin: AdminRuntimeConfig;
}

function nodeEnvironment(value: string | undefined): NodeEnvironment {
	const normalized = value ?? "development";
	if (
		normalized !== "development" &&
		normalized !== "test" &&
		normalized !== "production"
	) {
		throw new Error("NODE_ENV 必须是 development、test 或 production");
	}
	return normalized;
}

function port(value: string | undefined): number {
	const normalized = value ?? "3002";
	if (!/^[1-9]\d{0,4}$/u.test(normalized)) {
		throw new Error("ADMIN_PORT 必须是规范端口号");
	}
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed) || parsed > 65_535) {
		throw new Error("ADMIN_PORT 必须是规范端口号");
	}
	return parsed;
}

function bindHost(value: string | undefined, nodeEnv: NodeEnvironment): string {
	const normalized = value?.trim() || "127.0.0.1";
	if (normalized !== value && value !== undefined) {
		throw new Error("ADMIN_BIND_HOST 不得包含首尾空白");
	}
	if (isIP(normalized) === 0) {
		throw new Error("ADMIN_BIND_HOST 必须是明确的 IPv4 或 IPv6 地址");
	}
	if (nodeEnv === "production" && value === undefined) {
		throw new Error("生产管理员进程必须显式配置 ADMIN_BIND_HOST");
	}
	return normalized;
}

function trustedProxyCidrs(value: string | undefined): readonly string[] {
	if (value === undefined || value.length === 0) return Object.freeze([]);
	const entries = value.split(",");
	if (entries.some((entry) => entry.length === 0 || entry.trim() !== entry)) {
		throw new Error("ADMIN_TRUSTED_PROXY_CIDRS 包含空条目或首尾空白");
	}
	const normalized = entries.map((entry) => {
		const slash = entry.indexOf("/");
		if (slash !== entry.lastIndexOf("/")) {
			throw new Error("ADMIN_TRUSTED_PROXY_CIDRS 包含无效 CIDR");
		}
		const address = slash < 0 ? entry : entry.slice(0, slash);
		const family = isIP(address);
		if (family === 0) {
			throw new Error("ADMIN_TRUSTED_PROXY_CIDRS 包含无效地址");
		}
		if (slash < 0) return address;
		const prefixText = entry.slice(slash + 1);
		if (!/^\d{1,3}$/u.test(prefixText)) {
			throw new Error("ADMIN_TRUSTED_PROXY_CIDRS 包含无效 CIDR");
		}
		const prefix = Number(prefixText);
		const maximum = family === 4 ? 32 : 128;
		if (prefix < 1 || prefix > maximum) {
			throw new Error("ADMIN_TRUSTED_PROXY_CIDRS 禁止通配网段或无效 CIDR");
		}
		return `${address}/${prefix}`;
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new Error("ADMIN_TRUSTED_PROXY_CIDRS 不能重复");
	}
	return Object.freeze(normalized);
}

export function loadAdminProcessConfig(
	env: NodeJS.ProcessEnv = process.env,
): AdminProcessConfig {
	const parsedNodeEnvironment = nodeEnvironment(env.NODE_ENV);
	// Validate the process/network boundary before decoding any administrator
	// database or cryptographic secret into memory.
	const parsedPort = port(env.ADMIN_PORT);
	const parsedBindHost = bindHost(env.ADMIN_BIND_HOST, parsedNodeEnvironment);
	const proxies = trustedProxyCidrs(env.ADMIN_TRUSTED_PROXY_CIDRS);
	if (parsedNodeEnvironment === "production" && proxies.length === 0) {
		throw new Error(
			"生产管理员进程必须显式配置仅包含同源 BFF 的 ADMIN_TRUSTED_PROXY_CIDRS",
		);
	}
	const admin = loadAdminRuntimeConfig(env, parsedNodeEnvironment);
	if (!admin.enabled) {
		throw new Error("管理员进程拒绝在 ADMIN_API_ENABLED=false 时启动");
	}
	return Object.freeze({
		nodeEnv: parsedNodeEnvironment,
		port: parsedPort,
		bindHost: parsedBindHost,
		trustedProxyCidrs: proxies,
		admin,
	});
}
