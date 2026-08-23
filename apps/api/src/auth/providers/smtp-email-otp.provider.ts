import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { AuthRuntimeConfig } from "../auth-config.js";
import {
	type OtpDeliveryProvider,
	type OtpDeliveryReceipt,
	type OtpDeliveryRequest,
	OtpDeliveryUnavailableError,
	validateOtpDeliveryRequest,
} from "./otp-delivery.provider.js";

const SAFE_SMTP_STARTUP_FAILURE = "账号 SMTP 邮件服务不可用";

export interface SmtpSendResult {
	readonly messageId?: unknown;
	readonly accepted?: unknown;
	readonly rejected?: unknown;
	readonly pending?: unknown;
}

export interface SmtpTransportClient {
	verify(): Promise<unknown>;
	sendMail(message: SMTPTransport.Options): Promise<SmtpSendResult>;
	close(): void;
}

export interface SmtpTransportDependencies {
	createTransport(options: SMTPTransport.Options): SmtpTransportClient;
}

const SMTP_DEPENDENCIES: SmtpTransportDependencies = Object.freeze({
	createTransport: (options: SMTPTransport.Options) =>
		nodemailer.createTransport(options),
});

export async function createVerifiedSmtpTransportClient(
	config: AuthRuntimeConfig["email"],
	dependencies: SmtpTransportDependencies = SMTP_DEPENDENCIES,
): Promise<SmtpTransportClient | undefined> {
	if (!config.enabled) return undefined;
	if (
		config.host === null ||
		config.username === null ||
		config.password === null ||
		config.fromAddress === null
	) {
		throw new Error(SAFE_SMTP_STARTUP_FAILURE);
	}

	let client: SmtpTransportClient | undefined;
	try {
		client = dependencies.createTransport({
			host: config.host,
			port: config.port,
			secure: config.secure,
			auth: {
				type: "login",
				user: config.username,
				pass: config.password,
			},
			ignoreTLS: false,
			requireTLS: !config.secure,
			opportunisticTLS: false,
			lmtp: false,
			connectionTimeout: config.timeoutMs,
			greetingTimeout: config.timeoutMs,
			socketTimeout: config.timeoutMs,
			dnsTimeout: config.timeoutMs,
			tls: {
				rejectUnauthorized: true,
				minVersion: "TLSv1.2",
				servername: config.host,
			},
			logger: false,
			debug: false,
			transactionLog: false,
			disableFileAccess: true,
			disableUrlAccess: true,
		});
		if ((await client.verify()) !== true) {
			throw new Error(SAFE_SMTP_STARTUP_FAILURE);
		}
		return client;
	} catch {
		client?.close();
		throw new Error(SAFE_SMTP_STARTUP_FAILURE);
	}
}

export class SmtpEmailOtpDeliveryProvider implements OtpDeliveryProvider {
	readonly channel = "EMAIL" as const;

	constructor(
		private readonly config: AuthRuntimeConfig["email"],
		private readonly client: SmtpTransportClient,
	) {}

	async send(request: OtpDeliveryRequest): Promise<OtpDeliveryReceipt> {
		if (!this.config.enabled || this.config.fromAddress === null) {
			throw new OtpDeliveryUnavailableError("DISABLED");
		}
		validateOtpDeliveryRequest(request, this.channel);
		const remainingMinutes = Math.max(
			1,
			Math.ceil((request.expiresAt.getTime() - Date.now()) / 60_000),
		);
		const requestReference = createHash("sha256")
			.update("chi-shen-me:smtp-otp:v1\0", "utf8")
			.update(request.idempotencyKey, "utf8")
			.digest("base64url");

		try {
			const result = await this.client.sendMail({
				from: {
					name: this.config.fromName,
					address: this.config.fromAddress,
				},
				to: [{ address: request.destination }],
				subject: "吃什么验证码",
				text: `你的验证码是 ${request.code}，${remainingMinutes} 分钟内有效。请勿向任何人透露。`,
				disableFileAccess: true,
				disableUrlAccess: true,
			});
			if (!smtpAcceptedExactly(result, request.destination)) {
				throw new OtpDeliveryUnavailableError("UPSTREAM_REJECTED");
			}
			return Object.freeze({
				provider: "SMTP" as const,
				requestReference,
			});
		} catch (error) {
			if (error instanceof OtpDeliveryUnavailableError) throw error;
			throw new OtpDeliveryUnavailableError(classifySmtpFailure(error));
		}
	}
}

function smtpAcceptedExactly(
	result: SmtpSendResult,
	destination: string,
): boolean {
	const accepted = normalizeAddresses(result.accepted);
	const rejected = normalizeAddresses(result.rejected);
	const pending = normalizeAddresses(result.pending);
	return (
		accepted.length === 1 &&
		accepted[0]?.toLowerCase() === destination.toLowerCase() &&
		rejected.length === 0 &&
		pending.length === 0
	);
}

function normalizeAddresses(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const addresses: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			addresses.push(entry);
			continue;
		}
		if (
			typeof entry === "object" &&
			entry !== null &&
			"address" in entry &&
			typeof entry.address === "string"
		) {
			addresses.push(entry.address);
		}
	}
	return addresses;
}

function primitiveField(
	error: unknown,
	field: "name" | "code" | "responseCode",
): string | number | undefined {
	if (typeof error !== "object" || error === null || !(field in error)) {
		return undefined;
	}
	const value = (error as Record<PropertyKey, unknown>)[field];
	return typeof value === "string" || typeof value === "number"
		? value
		: undefined;
}

function classifySmtpFailure(
	error: unknown,
): "TIMEOUT" | "UPSTREAM_REJECTED" | "NETWORK_ERROR" {
	const name = primitiveField(error, "name");
	const code = primitiveField(error, "code");
	const responseCode = primitiveField(error, "responseCode");
	if (
		name === "AbortError" ||
		code === "ETIMEDOUT" ||
		code === "ESOCKETTIMEDOUT"
	) {
		return "TIMEOUT";
	}
	if (
		typeof responseCode === "number" ||
		code === "EAUTH" ||
		code === "EENVELOPE" ||
		code === "EMESSAGE"
	) {
		return "UPSTREAM_REJECTED";
	}
	return "NETWORK_ERROR";
}
