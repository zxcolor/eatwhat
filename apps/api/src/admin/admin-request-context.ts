import { isIP } from "node:net";
import type { AdminDeviceId } from "@chi-shen-me/contracts";
import { BadRequestException, Injectable } from "@nestjs/common";
import type {
	AdminRequestBinding,
	AdminSessionProof,
} from "./admin.repository.js";
import { AdminCrypto } from "./admin-crypto.js";

export interface AdminHttpRequest {
	readonly ip?: string;
	readonly socket?: { readonly remoteAddress?: string };
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ParsedAdminRequestBinding {
	readonly deviceId: AdminDeviceId;
	readonly clientIp: string;
	readonly binding: AdminRequestBinding;
}

const ADMIN_DEVICE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

@Injectable()
export class AdminRequestContextFactory {
	constructor(private readonly crypto: AdminCrypto) {}

	current(request: AdminHttpRequest): ParsedAdminRequestBinding {
		const material = this.parseMaterial(request);
		const deviceHash = this.crypto.currentHash("DEVICE", material.deviceId);
		const requestIpHash = this.crypto.currentHash(
			"REQUEST_IP",
			material.clientIp,
		);
		if (deviceHash.keyVersion !== requestIpHash.keyVersion) {
			throw new Error("管理员绑定密钥版本不一致");
		}
		return Object.freeze({
			...material,
			binding: Object.freeze({
				deviceHash: deviceHash.value,
				requestIpHash: requestIpHash.value,
				bindingHashKeyVersion: deviceHash.keyVersion,
			}),
		});
	}

	sessionProofCandidates(
		request: AdminHttpRequest,
		rawToken: string,
	): readonly AdminSessionProof[] {
		const material = this.parseMaterial(request);
		const tokenHashes = this.crypto.hashCandidates("SESSION_TOKEN", rawToken);
		const deviceHashes = new Map(
			this.crypto
				.hashCandidates("DEVICE", material.deviceId)
				.map((hash) => [hash.keyVersion, hash.value]),
		);
		const ipHashes = new Map(
			this.crypto
				.hashCandidates("REQUEST_IP", material.clientIp)
				.map((hash) => [hash.keyVersion, hash.value]),
		);
		return Object.freeze(
			tokenHashes.flatMap((tokenHash) => {
				const deviceHash = deviceHashes.get(tokenHash.keyVersion);
				const requestIpHash = ipHashes.get(tokenHash.keyVersion);
				if (deviceHash === undefined || requestIpHash === undefined) return [];
				return [
					Object.freeze({
						sessionTokenHash: tokenHash.value,
						sessionTokenHashKeyVersion: tokenHash.keyVersion,
						deviceHash,
						requestIpHash,
						bindingHashKeyVersion: tokenHash.keyVersion,
					}),
				];
			}),
		);
	}

	private parseMaterial(request: AdminHttpRequest): {
		readonly deviceId: AdminDeviceId;
		readonly clientIp: string;
	} {
		const deviceHeader = request.headers["x-admin-device-id"];
		if (
			typeof deviceHeader !== "string" ||
			!ADMIN_DEVICE_PATTERN.test(deviceHeader)
		) {
			throw new BadRequestException({
				code: "INVALID_ADMIN_DEVICE",
				message: "缺少有效的管理员设备标识",
			});
		}
		const clientIp = request.ip ?? request.socket?.remoteAddress;
		if (
			typeof clientIp !== "string" ||
			clientIp.length > 64 ||
			isIP(clientIp) === 0
		) {
			throw new BadRequestException({
				code: "INVALID_ADMIN_REQUEST_CONTEXT",
				message: "管理员请求上下文无效",
			});
		}
		return Object.freeze({ deviceId: deviceHeader, clientIp });
	}
}
