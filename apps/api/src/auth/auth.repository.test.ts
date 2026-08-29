import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
	DatabasePool,
	DatabaseTransaction,
} from "../database/database-pool.js";
import type { SqlResult } from "../database/migration-runner.js";
import { PostgresAuthRepository } from "./auth.repository.js";
import type {
	OAuthProof,
	OAuthStateDraft,
	OtpChallengeDraft,
	OtpProof,
	SessionIssueDraft,
} from "./auth-workflow.types.js";

interface StoredOAuthState {
	readonly deviceHash: string;
	readonly flowHash: string;
	readonly createdAt: Date;
}

interface StoredPhoneChallenge {
	readonly id: string;
	readonly destinationDedupHash: string;
	readonly purpose: "LOGIN" | "REGISTER" | "BIND" | "RECOVERY";
	readonly deviceHash: string;
	readonly requestIpHash: string;
	readonly createdAt: Date;
}

class PhoneSendLimitDatabase {
	readonly rows: StoredPhoneChallenge[] = [];
	readonly calls: string[] = [];
	private readonly lockTails = new Map<string, Promise<void>>();

	isEnabled() {
		return true;
	}

	async withTransaction<Result>(
		work: (transaction: DatabaseTransaction) => Promise<Result>,
	): Promise<Result> {
		const releases: (() => void)[] = [];
		const transaction: DatabaseTransaction = {
			query: async <Row extends QueryResultRow>(
				text: string,
				values: readonly unknown[] = [],
			): Promise<SqlResult<Row>> => {
				this.calls.push(text);
				if (text.includes("pg_advisory_xact_lock")) {
					releases.push(await this.acquire(String(values[0])));
					return empty<Row>();
				}
				if (text.includes("SELECT id, masked_destination, expires_at")) {
					return empty<Row>();
				}
				if (text.includes("destination_day_count")) {
					const destinationDedupHash = String(values[0]);
					const pendingCutoff = values[5] as Date;
					const recent = this.rows.filter(
						(row) =>
							row.destinationDedupHash === destinationDedupHash &&
							row.createdAt.getTime() >= pendingCutoff.getTime(),
					);
					return result<Row>({
						destination_hour_count: recent.length,
						destination_day_count: recent.length,
						device_count: recent.filter(
							(row) => row.deviceHash === String(values[1]),
						).length,
						ip_count: recent.filter(
							(row) => row.requestIpHash === String(values[2]),
						).length,
						pending_count: recent.length,
						destination_hour_oldest: recent[0]?.createdAt ?? null,
						destination_day_oldest: recent[0]?.createdAt ?? null,
						device_oldest: recent[0]?.createdAt ?? null,
						ip_oldest: recent[0]?.createdAt ?? null,
						pending_oldest: recent[0]?.createdAt ?? null,
					});
				}
				if (text.includes("INSERT INTO public.otp_challenges")) {
					this.rows.push({
						id: String(values[0]),
						destinationDedupHash: String(values[5]),
						purpose: values[2] as StoredPhoneChallenge["purpose"],
						requestIpHash: String(values[17]),
						deviceHash: String(values[18]),
						createdAt: values[19] as Date,
					});
					return empty<Row>(1);
				}
				if (text.includes("supersede_phone_otp_challenges_for_send")) {
					return result<Row>({ changed: true });
				}
				throw new Error("unexpected SQL in PHONE send limit fake");
			},
		};
		try {
			return await work(transaction);
		} finally {
			for (const release of releases.reverse()) release();
		}
	}

	private async acquire(key: string): Promise<() => void> {
		const previous = this.lockTails.get(key) ?? Promise.resolve();
		let releaseCurrent = () => undefined;
		const current = new Promise<void>((resolve) => {
			releaseCurrent = resolve;
		});
		const tail = previous.then(() => current);
		this.lockTails.set(key, tail);
		await previous;
		return () => {
			releaseCurrent();
			if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
		};
	}
}

class OAuthLimitDatabase {
	readonly rows: StoredOAuthState[] = [];
	readonly calls: string[] = [];
	private readonly lockTails = new Map<string, Promise<void>>();

	isEnabled() {
		return true;
	}

	async withTransaction<Result>(
		work: (transaction: DatabaseTransaction) => Promise<Result>,
	): Promise<Result> {
		const releases: (() => void)[] = [];
		const transaction: DatabaseTransaction = {
			query: async <Row extends QueryResultRow>(
				text: string,
				values: readonly unknown[] = [],
			): Promise<SqlResult<Row>> => {
				this.calls.push(text);
				if (text.includes("pg_advisory_xact_lock")) {
					releases.push(await this.acquire(String(values[0])));
					return empty<Row>();
				}
				if (text.includes("FROM public.oauth_states WHERE created_at")) {
					const deviceHash = String(values[0]);
					const flowHash = String(values[1]);
					const cutoff = values[2] as Date;
					const recent = this.rows.filter(
						(row) => row.createdAt.getTime() >= cutoff.getTime(),
					);
					return result<Row>({
						device_count: recent.filter((row) => row.deviceHash === deviceHash)
							.length,
						flow_count: recent.filter((row) => row.flowHash === flowHash)
							.length,
					});
				}
				if (text.includes("INSERT INTO public.oauth_states")) {
					this.rows.push({
						flowHash: String(values[4]),
						deviceHash: String(values[7]),
						createdAt: values[9] as Date,
					});
					return empty<Row>(1);
				}
				throw new Error("unexpected SQL in OAuth limit fake");
			},
		};
		try {
			return await work(transaction);
		} finally {
			for (const release of releases.reverse()) release();
		}
	}

	private async acquire(key: string): Promise<() => void> {
		const previous = this.lockTails.get(key) ?? Promise.resolve();
		let releaseCurrent = () => undefined;
		const current = new Promise<void>((resolve) => {
			releaseCurrent = resolve;
		});
		const tail = previous.then(() => current);
		this.lockTails.set(key, tail);
		await previous;
		return () => {
			releaseCurrent();
			if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
		};
	}
}

function oauthDraft(
	id: number,
	purpose: "LOGIN" | "BIND",
	flowHash = "f".repeat(64),
): OAuthStateDraft {
	const createdAt = new Date("2026-08-21T04:00:00.000Z");
	return {
		id: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
		provider: "WECHAT",
		purpose,
		stateHash: { value: id.toString(16).padStart(64, "0"), keyVersion: "v1" },
		flowReferenceHash: flowHash,
		operationTargetHash: null,
		targetUserId: null,
		deviceHash: "d".repeat(64),
		createdAt,
		expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
		retainUntil: new Date(createdAt.getTime() + 24 * 60 * 60_000),
	};
}

function otpDraft(
	createdAt = new Date("2026-08-21T04:00:00.000Z"),
): OtpChallengeDraft {
	return {
		id: "10000000-0000-4000-8000-000000000001",
		channel: "PHONE",
		purpose: "LOGIN",
		destinationLookup: { value: "1".repeat(64), keyVersion: "v1" },
		destinationDedup: { value: "2".repeat(64), keyVersion: "stable" },
		maskedDestination: "+86138****8000",
		operationTargetHash: null,
		targetUserId: null,
		registrationFlowReferenceHash: null,
		verificationMethod: "ALIYUN_PNVS",
		codeHash: null,
		idempotencyKeyHash: "3".repeat(64),
		hashKeyVersion: "v1",
		requestIpHash: "4".repeat(64),
		deviceHash: "5".repeat(64),
		createdAt,
		retainUntil: new Date(createdAt.getTime() + 24 * 60 * 60_000),
		expiresAt: new Date(createdAt.getTime() + 5 * 60_000),
		resendAvailableAt: new Date(createdAt.getTime() + 60_000),
	};
}

class ScriptedDatabase {
	readonly calls: string[] = [];
	constructor(
		private readonly answer: (
			text: string,
			values: readonly unknown[],
		) => SqlResult<QueryResultRow>,
	) {}
	isEnabled() {
		return true;
	}
	async withTransaction<Result>(
		work: (transaction: DatabaseTransaction) => Promise<Result>,
	): Promise<Result> {
		return work({
			query: async <Row extends QueryResultRow>(
				text: string,
				values: readonly unknown[] = [],
			) => {
				this.calls.push(text);
				return this.answer(text, values) as SqlResult<Row>;
			},
		});
	}
}

class ExportQueueDatabase {
	readonly calls: string[] = [];
	row: {
		readonly export_id: string;
		readonly export_status: "QUEUED";
		readonly requested_at: Date;
		readonly expires_at: Date;
		readonly include_behavior_history: boolean;
	} | null = null;
	private tail = Promise.resolve();

	isEnabled() {
		return true;
	}

	async withTransaction<Result>(
		work: (transaction: DatabaseTransaction) => Promise<Result>,
	): Promise<Result> {
		let release = () => undefined;
		const transaction: DatabaseTransaction = {
			query: async <Row extends QueryResultRow>(
				text: string,
				values: readonly unknown[] = [],
			): Promise<SqlResult<Row>> => {
				this.calls.push(text);
				if (text.includes("SELECT family.id")) {
					return result<Row>({ id: authenticatedContext.sessionId });
				}
				if (text.includes("app_queue_data_export")) {
					const previous = this.tail;
					let releaseCurrent = () => undefined;
					const current = new Promise<void>((resolve) => {
						releaseCurrent = resolve;
					});
					this.tail = previous.then(() => current);
					await previous;
					release = releaseCurrent;
					const outcome = this.row === null ? "CREATED" : "REPLAY";
					if (this.row === null) {
						const requestedAt = new Date("2026-08-21T05:30:00.000Z");
						this.row = {
							export_id: String(values[1]),
							export_status: "QUEUED",
							requested_at: requestedAt,
							expires_at: new Date(
								requestedAt.getTime() + 7 * 24 * 60 * 60_000,
							),
							include_behavior_history: Boolean(values[2]),
						};
					}
					return result<Row>({
						outcome,
						...this.row,
						ready_at: null,
						failure_code: null,
						artifact_size_bytes: null,
						artifact_sha256: null,
					});
				}
				throw new Error("unexpected SQL in export queue fake");
			},
		};
		try {
			return await work(transaction);
		} finally {
			release();
		}
	}
}

const otpProof: OtpProof = {
	id: "3bf405ae-82a1-4f87-86b7-1c97c4a8683f",
	channel: "PHONE",
	purpose: "LOGIN",
	destinationDedupHash: "a".repeat(64),
	verificationMethod: "ALIYUN_PNVS",
	codeHash: null,
	codeHashKeyVersion: null,
	operationTargetHash: null,
	targetUserId: null,
	registrationFlowReferenceHash: null,
	deviceHash: "b".repeat(64),
	hashKeyVersion: "v1",
};

const registrationOtpProof: OtpProof = {
	...otpProof,
	purpose: "REGISTER",
	registrationFlowReferenceHash: "f".repeat(64),
};

const emailLoginOtpProof: OtpProof = {
	...otpProof,
	channel: "EMAIL",
	verificationMethod: "LOCAL_HASH",
	codeHash: "encoded-argon-hash",
	codeHashKeyVersion: "pepper-v1",
};

const sessionDraft: SessionIssueDraft = {
	sessionId: "77777777-7777-4777-8777-777777777777",
	refreshCredentialId: "88888888-8888-4888-8888-888888888888",
	accessCredentialId: "99999999-9999-4999-8999-999999999999",
	device: {
		installationId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
		label: "Pixel test",
		platform: "ANDROID",
		appVersion: "1.0.0",
	},
	deviceHash: registrationOtpProof.deviceHash,
	requestIpHash: "1".repeat(64),
	hashKeyVersion: "v1",
	refreshTokenHash: { value: "2".repeat(64), keyVersion: "v1" },
	accessTokenHash: { value: "3".repeat(64), keyVersion: "v1" },
	issuedAt: new Date("2026-08-21T04:00:00.000Z"),
	refreshExpiresAt: new Date("2026-09-01T04:00:00.000Z"),
	sessionRetainUntil: new Date("2026-10-01T04:00:00.000Z"),
	accessExpiresAt: new Date("2026-08-21T04:15:00.000Z"),
	accessRetainUntil: new Date("2026-08-22T04:15:00.000Z"),
};

const verifiedWechatIdentity = {
	lookup: { value: "4".repeat(64), keyVersion: "v1" },
	dedup: { value: "5".repeat(64), keyVersion: "v1" },
	wechatUnionAlias: {
		realmId: "eatwhat-primary",
		hash: { value: "6".repeat(64), keyVersion: "v1" },
	},
};

const authenticatedContext = {
	userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	sessionId: sessionDraft.sessionId,
	deviceHash: sessionDraft.deviceHash,
};

const bindingOtpProof: OtpProof = {
	...otpProof,
	channel: "EMAIL",
	purpose: "BIND",
	verificationMethod: "LOCAL_HASH",
	codeHash: "encoded-argon-hash",
	codeHashKeyVersion: "pepper-v1",
	operationTargetHash: "6".repeat(64),
	targetUserId: authenticatedContext.userId,
	deviceHash: authenticatedContext.deviceHash,
};

const bindingOAuthProof: OAuthProof = {
	id: "66666666-6666-4666-8666-666666666666",
	provider: "QQ",
	purpose: "BIND",
	flowReferenceHash: "f".repeat(64),
	operationTargetHash: "7".repeat(64),
	targetUserId: authenticatedContext.userId,
	deviceHash: authenticatedContext.deviceHash,
	hashKeyVersion: "v1",
};

describe("PostgresAuthRepository transaction workflows", () => {
	it("enforces the ten-per-24-hour OTP recipient ceiling with an accurate retry", async () => {
		const now = new Date("2026-08-21T04:00:00.000Z");
		const database = new ScriptedDatabase((text, values) => {
			if (text.includes("pg_advisory_xact_lock")) return empty();
			if (text.includes("SELECT id, masked_destination, expires_at")) {
				return empty();
			}
			if (text.includes("destination_day_count")) {
				expect(values[6]).toEqual(new Date("2026-08-20T04:00:00.000Z"));
				return result({
					destination_hour_count: 2,
					destination_day_count: 10,
					device_count: 2,
					ip_count: 2,
					pending_count: 0,
					destination_hour_oldest: new Date("2026-08-21T03:30:00.000Z"),
					destination_day_oldest: new Date("2026-08-20T05:00:00.000Z"),
					device_oldest: new Date("2026-08-21T03:30:00.000Z"),
					ip_oldest: new Date("2026-08-21T03:30:00.000Z"),
					pending_oldest: null,
				});
			}
			throw new Error("daily-limited OTP must not be inserted");
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);

		await expect(repository.createOtpChallenge(otpDraft(now))).resolves.toEqual(
			{
				kind: "RATE_LIMITED",
				retryAfterSeconds: 3_600,
			},
		);
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.otp_challenges"),
			),
		).toBe(false);
	});

	it("uses the longest active OTP scope when calculating Retry-After", async () => {
		const now = new Date("2026-08-21T04:00:00.000Z");
		const database = new ScriptedDatabase((text, values) => {
			if (text.includes("pg_advisory_xact_lock")) return empty();
			if (text.includes("SELECT id, masked_destination, expires_at")) {
				return empty();
			}
			if (text.includes("destination_day_count")) {
				expect(text).toContain("$8::text = 'PHONE'");
				expect(text).toContain("delivery_status IN ('PENDING', 'SENT')");
				expect(values[7]).toBe("PHONE");
				return result({
					destination_hour_count: 5,
					destination_day_count: 10,
					device_count: 10,
					ip_count: 0,
					pending_count: 1,
					destination_hour_oldest: new Date("2026-08-21T03:15:00.000Z"),
					destination_day_oldest: new Date("2026-08-20T04:30:00.000Z"),
					device_oldest: new Date("2026-08-21T03:50:00.000Z"),
					ip_oldest: null,
					pending_oldest: new Date("2026-08-21T03:59:30.000Z"),
				});
			}
			throw new Error("rate-limited OTP must not be inserted");
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);

		await expect(repository.createOtpChallenge(otpDraft(now))).resolves.toEqual(
			{
				kind: "RATE_LIMITED",
				retryAfterSeconds: 3_000,
			},
		);
	});

	it("persists a PNVS phone challenge without any locally verifiable OTP", async () => {
		const now = new Date("2026-08-21T04:00:00.000Z");
		let insertValues: readonly unknown[] = [];
		const database = new ScriptedDatabase((text, values) => {
			if (text.includes("pg_advisory_xact_lock")) return empty();
			if (text.includes("SELECT id, masked_destination, expires_at")) {
				return empty();
			}
			if (text.includes("destination_day_count")) {
				return result({
					destination_hour_count: 0,
					destination_day_count: 0,
					device_count: 0,
					ip_count: 0,
					pending_count: 0,
					destination_hour_oldest: null,
					destination_day_oldest: null,
					device_oldest: null,
					ip_oldest: null,
					pending_oldest: null,
				});
			}
			if (text.includes("INSERT INTO public.otp_challenges")) {
				insertValues = values;
				return empty(1);
			}
			if (text.includes("supersede_phone_otp_challenges_for_send")) {
				expect(values).toEqual(["10000000-0000-4000-8000-000000000001"]);
				return result({ changed: true });
			}
			throw new Error("unexpected PNVS challenge SQL");
		});

		await expect(
			new PostgresAuthRepository(
				database as unknown as DatabasePool,
			).createOtpChallenge(otpDraft(now)),
		).resolves.toEqual({ kind: "CREATED" });
		expect(insertValues[11]).toBe("ALIYUN_PNVS");
		expect(insertValues.slice(12, 15)).toEqual([null, null, null]);
	});

	it("allows only one provider send for concurrent same-number requests across purposes and devices", async () => {
		const now = new Date("2026-08-21T04:00:00.000Z");
		const database = new PhoneSendLimitDatabase();
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const providerSend = vi.fn(async () => undefined);
		const loginDraft = otpDraft(now);
		const registerDraft: OtpChallengeDraft = {
			...otpDraft(now),
			id: "10000000-0000-4000-8000-000000000002",
			purpose: "REGISTER",
			registrationFlowReferenceHash: "6".repeat(64),
			idempotencyKeyHash: "7".repeat(64),
			requestIpHash: "8".repeat(64),
			deviceHash: "9".repeat(64),
		};

		const outcomes = await Promise.all(
			[loginDraft, registerDraft].map(async (draft) => {
				const outcome = await repository.createOtpChallenge(draft);
				if (outcome.kind === "CREATED") await providerSend();
				return outcome;
			}),
		);

		expect(
			outcomes.filter((outcome) => outcome.kind === "CREATED"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.kind === "RATE_LIMITED"),
		).toHaveLength(1);
		expect(providerSend).toHaveBeenCalledTimes(1);
		expect(database.rows).toHaveLength(1);
		expect(
			database.calls.filter((sql) =>
				sql.includes("supersede_phone_otp_challenges_for_send"),
			),
		).toHaveLength(1);
	});

	it("serializes concurrent login state requests so the DB limit cannot be bypassed", async () => {
		const database = new OAuthLimitDatabase();
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const outcomes = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				repository.createOAuthState(oauthDraft(index + 1, "LOGIN")),
			),
		);
		expect(
			outcomes.filter((outcome) => outcome.kind === "CREATED"),
		).toHaveLength(10);
		expect(
			outcomes.filter((outcome) => outcome.kind === "RATE_LIMITED"),
		).toHaveLength(10);
		expect(database.rows).toHaveLength(10);
	});

	it("completes a failed claimed phone verification without resolving an identity or issuing tokens", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("complete_otp_verification_lease")) {
				return result({ changed: false });
			}
			throw new Error("unexpected SQL after rejected OTP");
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const completion = await repository.completeOtpLogin({
			proof: otpProof,
			verificationSucceeded: false,
			session: null,
			newUserId: null,
			verificationClaimHash: "c".repeat(64),
		});
		expect(completion).toEqual({ kind: "INVALID_CREDENTIALS" });
		expect(database.calls).toHaveLength(1);
	});

	it("does not create an account or session for a verified but unbound EMAIL login", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: true });
			}
			if (text.includes("SELECT binding.user_id")) return empty();
			throw new Error("unbound EMAIL login must not create account state");
		});

		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOtpLogin({
			proof: emailLoginOtpProof,
			verificationSucceeded: true,
			session: sessionDraft,
			newUserId: null,
			verificationClaimHash: null,
		});

		expect(outcome).toEqual({ kind: "INVALID_CREDENTIALS" });
		expect(
			database.calls.some(
				(sql) =>
					sql.includes("register_phone_account_from_consumed_otp") ||
					sql.includes("INSERT INTO public.auth_"),
			),
		).toBe(false);
	});

	it("claims a phone verification lease with every proof boundary before the provider call", async () => {
		let parameters: readonly unknown[] = [];
		const leaseUntil = new Date("2026-08-21T04:00:30.000Z");
		const database = new ScriptedDatabase((text, values) => {
			expect(text).toContain("claim_otp_verification_lease");
			parameters = values;
			return result({ changed: true });
		});
		const claimed = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).claimPhoneOtpVerification(otpProof, "c".repeat(64), leaseUntil);

		expect(claimed).toBe(true);
		expect(parameters).toEqual([
			otpProof.id,
			"LOGIN",
			null,
			null,
			otpProof.deviceHash,
			"c".repeat(64),
			leaseUntil,
		]);
	});

	it("uses one REGISTER phone challenge to log in an existing account", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("complete_otp_verification_lease")) {
				return result({ changed: true });
			}
			if (text.includes("SELECT binding.user_id")) {
				return result({ user_id: authenticatedContext.userId });
			}
			if (text.includes("INSERT INTO public.auth_")) return empty(1);
			throw new Error("unexpected existing phone account SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOtpLogin({
			proof: registrationOtpProof,
			verificationSucceeded: true,
			session: sessionDraft,
			newUserId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			verificationClaimHash: "c".repeat(64),
		});

		expect(outcome).toMatchObject({
			kind: "SUCCESS",
			userId: authenticatedContext.userId,
		});
		expect(
			database.calls.some((sql) =>
				sql.includes("register_phone_account_from_consumed_otp"),
			),
		).toBe(false);
	});

	it("uses the same REGISTER phone challenge to atomically create a new account", async () => {
		const newUserId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		const database = new ScriptedDatabase((text) => {
			if (text.includes("complete_otp_verification_lease")) {
				return result({ changed: true });
			}
			if (text.includes("SELECT binding.user_id")) return empty();
			if (text.includes("register_phone_account_from_consumed_otp")) {
				return result({ changed: true });
			}
			if (text.includes("INSERT INTO public.auth_")) return empty(1);
			throw new Error("unexpected new phone account SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOtpLogin({
			proof: registrationOtpProof,
			verificationSucceeded: true,
			session: sessionDraft,
			newUserId,
			verificationClaimHash: "c".repeat(64),
		});

		expect(outcome).toEqual({
			kind: "SUCCESS",
			userId: newUserId,
			sessionId: sessionDraft.sessionId,
		});
		const complete = database.calls.findIndex((sql) =>
			sql.includes("complete_otp_verification_lease"),
		);
		const register = database.calls.findIndex((sql) =>
			sql.includes("register_phone_account_from_consumed_otp"),
		);
		const session = database.calls.findIndex((sql) =>
			sql.includes("INSERT INTO public.auth_session_families"),
		);
		expect(complete).toBeLessThan(register);
		expect(register).toBeLessThan(session);
	});

	it("logs into the account that wins a concurrent REGISTER phone binding race", async () => {
		const newUserId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		let identityLookupCount = 0;
		const database = new ScriptedDatabase((text) => {
			if (text.includes("complete_otp_verification_lease")) {
				return result({ changed: true });
			}
			if (text.includes("SELECT binding.user_id")) {
				identityLookupCount += 1;
				return identityLookupCount === 1
					? empty()
					: result({ user_id: authenticatedContext.userId });
			}
			if (text.includes("register_phone_account_from_consumed_otp")) {
				return result({ changed: false });
			}
			if (text.includes("INSERT INTO public.auth_")) return empty(1);
			throw new Error("unexpected concurrent phone account SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOtpLogin({
			proof: registrationOtpProof,
			verificationSucceeded: true,
			session: sessionDraft,
			newUserId,
			verificationClaimHash: "c".repeat(64),
		});

		expect(outcome).toEqual({
			kind: "SUCCESS",
			userId: authenticatedContext.userId,
			sessionId: sessionDraft.sessionId,
		});
		expect(identityLookupCount).toBe(2);
	});

	it("consumes a verified unbound WeChat state without creating an account or session", async () => {
		const proof: OAuthProof = {
			id: "12121212-1212-4212-8212-121212121212",
			provider: "WECHAT",
			purpose: "LOGIN",
			flowReferenceHash: "f".repeat(64),
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: sessionDraft.deviceHash,
			hashKeyVersion: "v1",
		};
		const database = new ScriptedDatabase((text) => {
			if (text.includes("consume_oauth_state")) {
				return result({ changed: true });
			}
			if (
				text.includes("binding.lookup_hash = $2 OR binding.dedup_hash = $3")
			) {
				return empty();
			}
			throw new Error("unbound WeChat identity must not create a session");
		});

		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOAuthLogin({
			proof,
			verifiedIdentity: verifiedWechatIdentity,
			session: sessionDraft,
		});

		expect(outcome).toEqual({ kind: "IDENTITY_NOT_BOUND" });
		expect(database.calls[0]).toContain("consume_oauth_state");
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.auth_session_families"),
			),
		).toBe(false);
	});

	it("records a verified WeChat UnionID alias before issuing the owner session", async () => {
		const proof: OAuthProof = {
			id: "13131313-1313-4313-8313-131313131313",
			provider: "WECHAT",
			purpose: "LOGIN",
			flowReferenceHash: "f".repeat(64),
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: sessionDraft.deviceHash,
			hashKeyVersion: "v1",
		};
		const bindingId = "14141414-1414-4414-8414-141414141414";
		let consumeValues: readonly unknown[] = [];
		let aliasValues: readonly unknown[] = [];
		const database = new ScriptedDatabase((text, values) => {
			if (text.includes("consume_oauth_state_with_wechat_union")) {
				consumeValues = values;
				return result({ changed: true });
			}
			if (
				text.includes("binding.lookup_hash = $2 OR binding.dedup_hash = $3")
			) {
				return result({
					id: bindingId,
					user_id: authenticatedContext.userId,
					revoked_at: null,
					user_status: "ACTIVE",
				});
			}
			if (text.includes("record_wechat_union_alias_from_consumed_state")) {
				aliasValues = values;
				return result({ changed: true });
			}
			if (text.includes("INSERT INTO public.auth_")) return empty(1);
			throw new Error("unexpected successful WeChat login SQL");
		});

		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOAuthLogin({
			proof,
			verifiedIdentity: verifiedWechatIdentity,
			session: sessionDraft,
		});

		expect(outcome).toEqual({
			kind: "SUCCESS",
			userId: authenticatedContext.userId,
			sessionId: sessionDraft.sessionId,
		});
		expect(consumeValues.slice(11)).toEqual([
			verifiedWechatIdentity.wechatUnionAlias.realmId,
			verifiedWechatIdentity.wechatUnionAlias.hash.value,
			verifiedWechatIdentity.wechatUnionAlias.hash.keyVersion,
		]);
		expect(aliasValues).toEqual([proof.id, bindingId]);
		const consume = database.calls.findIndex((sql) =>
			sql.includes("consume_oauth_state_with_wechat_union"),
		);
		const alias = database.calls.findIndex((sql) =>
			sql.includes("record_wechat_union_alias_from_consumed_state"),
		);
		const session = database.calls.findIndex((sql) =>
			sql.includes("INSERT INTO public.auth_session_families"),
		);
		expect(consume).toBeGreaterThan(-1);
		expect(consume).toBeLessThan(alias);
		expect(alias).toBeLessThan(session);
		expect(
			database.calls.some((sql) =>
				sql.includes("SELECT public.consume_oauth_state("),
			),
		).toBe(false);
	});

	it("rejects a WeChat login when its UnionID alias cannot be recorded", async () => {
		const proof: OAuthProof = {
			id: "15151515-1515-4515-8515-151515151515",
			provider: "WECHAT",
			purpose: "LOGIN",
			flowReferenceHash: "f".repeat(64),
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: sessionDraft.deviceHash,
			hashKeyVersion: "v1",
		};
		const database = new ScriptedDatabase((text) => {
			if (text.includes("consume_oauth_state_with_wechat_union")) {
				return result({ changed: true });
			}
			if (
				text.includes("binding.lookup_hash = $2 OR binding.dedup_hash = $3")
			) {
				return result({
					id: "16161616-1616-4616-8616-161616161616",
					user_id: authenticatedContext.userId,
					revoked_at: null,
					user_status: "ACTIVE",
				});
			}
			if (text.includes("record_wechat_union_alias_from_consumed_state")) {
				return result({ changed: false });
			}
			throw new Error("conflicting WeChat UnionID must not issue a session");
		});

		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOAuthLogin({
			proof,
			verifiedIdentity: verifiedWechatIdentity,
			session: sessionDraft,
		});

		expect(outcome).toEqual({ kind: "IDENTITY_CONFLICT" });
		expect(
			database.calls.filter((sql) =>
				sql.includes("record_wechat_union_alias_from_consumed_state"),
			),
		).toHaveLength(1);
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.auth_session_families"),
			),
		).toBe(false);
	});

	it("rejects conflicting QQ OpenID and UnionID owners without merging accounts", async () => {
		const proof: OAuthProof = {
			id: "12121212-1212-4212-8212-121212121212",
			provider: "QQ",
			purpose: "LOGIN",
			flowReferenceHash: "f".repeat(64),
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: sessionDraft.deviceHash,
			hashKeyVersion: "v1",
		};
		const database = new ScriptedDatabase((text) => {
			if (text.includes("consume_oauth_state")) {
				return result({ changed: true });
			}
			if (
				text.includes("binding.lookup_hash = $2 OR binding.dedup_hash = $3")
			) {
				return {
					rows: [
						{
							user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							revoked_at: null,
							user_status: "ACTIVE",
						},
						{
							user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
							revoked_at: null,
							user_status: "ACTIVE",
						},
					],
					rowCount: 2,
				};
			}
			throw new Error("conflicting QQ identities must not issue a session");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOAuthLogin({
			proof,
			verifiedIdentity: {
				lookup: { value: "4".repeat(64), keyVersion: "v1" },
				dedup: { value: "5".repeat(64), keyVersion: "stable-v1" },
				wechatUnionAlias: null,
			},
			session: sessionDraft,
		});

		expect(outcome).toEqual({ kind: "IDENTITY_CONFLICT" });
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.auth_session_families"),
			),
		).toBe(false);
	});

	it("inserts the replacement refresh before rotate and access issuance", async () => {
		const activeRow = {
			credential_id: "11111111-1111-4111-8111-111111111111",
			session_family_id: "22222222-2222-4222-8222-222222222222",
			generation: 4,
			consumed_at: null,
			replay_detected_at: null,
			credential_expires_at: new Date("2026-09-01T00:00:00.000Z"),
			family_status: "ACTIVE",
			refresh_expires_at: new Date("2026-09-01T00:00:00.000Z"),
			device_hash: "b".repeat(64),
			user_id: "33333333-3333-4333-8333-333333333333",
			user_status: "ACTIVE",
		};
		const database = new ScriptedDatabase((text) => {
			if (
				text.includes("JOIN unnest") ||
				text.includes("WHERE credential.id")
			) {
				return result(activeRow);
			}
			if (text.includes("rotate_auth_refresh_credential")) {
				return result({ changed: true });
			}
			return empty(1);
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const outcome = await repository.refreshSession(
			[{ value: "c".repeat(64), keyVersion: "v1" }],
			["b".repeat(64)],
			{
				refreshCredentialId: "44444444-4444-4444-8444-444444444444",
				accessCredentialId: "55555555-5555-4555-8555-555555555555",
				refreshTokenHash: { value: "d".repeat(64), keyVersion: "v1" },
				accessTokenHash: { value: "e".repeat(64), keyVersion: "v1" },
				issuedAt: new Date("2026-08-21T04:00:00.000Z"),
				accessExpiresAt: new Date("2026-08-21T04:15:00.000Z"),
				accessRetainUntil: new Date("2026-08-22T04:15:00.000Z"),
			},
		);
		expect(outcome).toMatchObject({
			kind: "SUCCESS",
			accessExpiresAt: expect.any(Date),
		});
		const replacement = database.calls.findIndex((sql) =>
			sql.includes("INSERT INTO public.auth_refresh_credentials"),
		);
		const rotate = database.calls.findIndex((sql) =>
			sql.includes("rotate_auth_refresh_credential"),
		);
		const access = database.calls.findIndex((sql) =>
			sql.includes("INSERT INTO public.auth_access_tokens"),
		);
		expect(replacement).toBeGreaterThan(-1);
		expect(replacement).toBeLessThan(rotate);
		expect(rotate).toBeLessThan(access);
	});

	it("marks a consumed refresh as replay before returning and never issues tokens", async () => {
		const consumedRow = {
			credential_id: "11111111-1111-4111-8111-111111111111",
			session_family_id: "22222222-2222-4222-8222-222222222222",
			generation: 4,
			consumed_at: new Date("2026-08-21T03:59:00.000Z"),
			replay_detected_at: null,
			credential_expires_at: new Date("2026-09-01T00:00:00.000Z"),
			family_status: "ACTIVE",
			refresh_expires_at: new Date("2026-09-01T00:00:00.000Z"),
			device_hash: "b".repeat(64),
			user_id: "33333333-3333-4333-8333-333333333333",
			user_status: "ACTIVE",
		};
		const database = new ScriptedDatabase((text) => {
			if (
				text.includes("JOIN unnest") ||
				text.includes("WHERE credential.id")
			) {
				return result(consumedRow);
			}
			if (text.includes("mark_auth_refresh_replay")) {
				return result({ changed: true });
			}
			return empty(1);
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const outcome = await repository.refreshSession(
			[{ value: "c".repeat(64), keyVersion: "v1" }],
			["b".repeat(64)],
			{
				refreshCredentialId: "44444444-4444-4444-8444-444444444444",
				accessCredentialId: "55555555-5555-4555-8555-555555555555",
				refreshTokenHash: { value: "d".repeat(64), keyVersion: "v1" },
				accessTokenHash: { value: "e".repeat(64), keyVersion: "v1" },
				issuedAt: new Date("2026-08-21T04:00:00.000Z"),
				accessExpiresAt: new Date("2026-08-21T04:15:00.000Z"),
				accessRetainUntil: new Date("2026-08-22T04:15:00.000Z"),
			},
		);
		expect(outcome).toEqual({ kind: "REPLAY" });
		expect(
			database.calls.some((sql) => sql.includes("mark_auth_refresh_replay")),
		).toBe(true);
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.auth_refresh_credentials"),
			),
		).toBe(false);
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.auth_access_tokens"),
			),
		).toBe(false);
	});

	it("checks EMAIL BIND conflicts before atomically consuming and invoking the restricted binding primitive", async () => {
		const bindingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (
				text.includes("FROM public.identity_bindings") &&
				text.includes("dedup_hash")
			) {
				return empty();
			}
			if (
				text.includes("WHERE user_id = $1") &&
				text.includes("identity_type = 'EMAIL'")
			) {
				return empty();
			}
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: true });
			}
			if (text.includes("bind_email_identity_from_consumed_otp")) {
				return result({ id: bindingId });
			}
			if (text.includes("WHERE id = $1 AND user_id = $2")) {
				return result({
					id: bindingId,
					identity_type: "EMAIL",
					masked_display_hint: "s*****t@example.com",
					is_primary: false,
					verified_at: new Date("2026-08-21T05:00:00.000Z"),
					revoked_at: null,
				});
			}
			throw new Error("unexpected email binding SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOtpBinding({
			session: authenticatedContext,
			proof: bindingOtpProof,
			verificationSucceeded: true,
		});
		expect(outcome).toMatchObject({
			kind: "SUCCESS",
			binding: { bindingId, type: "EMAIL", canUnbind: true },
		});
		const consume = database.calls.findIndex((sql) =>
			sql.includes("record_otp_verification_attempt"),
		);
		const ownerConflict = database.calls.findIndex(
			(sql) => sql.includes("dedup_hash = $2") && sql.includes("identity_type"),
		);
		const activeEmail = database.calls.findIndex(
			(sql) =>
				sql.includes("WHERE user_id = $1") &&
				sql.includes("identity_type = 'EMAIL'"),
		);
		const bind = database.calls.findIndex((sql) =>
			sql.includes("bind_email_identity_from_consumed_otp"),
		);
		expect(ownerConflict).toBeGreaterThan(-1);
		expect(ownerConflict).toBeLessThan(activeEmail);
		expect(activeEmail).toBeLessThan(consume);
		expect(consume).toBeGreaterThan(-1);
		expect(consume).toBeLessThan(bind);
	});

	it("returns an EMAIL owner conflict without consuming the verified BIND proof", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("dedup_hash = $2")) {
				return result({
					user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
					revoked_at: null,
				});
			}
			throw new Error("conflicted EMAIL proof must not be consumed");
		});

		await expect(
			new PostgresAuthRepository(
				database as unknown as DatabasePool,
			).completeOtpBinding({
				session: authenticatedContext,
				proof: bindingOtpProof,
				verificationSucceeded: true,
			}),
		).resolves.toEqual({ kind: "IDENTITY_CONFLICT" });
		expect(
			database.calls.some((sql) =>
				sql.includes("record_otp_verification_attempt"),
			),
		).toBe(false);
	});

	it("returns a conflict when the user already has another active EMAIL without consuming the proof", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("dedup_hash = $2")) return empty();
			if (
				text.includes("WHERE user_id = $1") &&
				text.includes("identity_type = 'EMAIL'")
			) {
				return result({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
			}
			throw new Error("second active EMAIL proof must not be consumed");
		});

		await expect(
			new PostgresAuthRepository(
				database as unknown as DatabasePool,
			).completeOtpBinding({
				session: authenticatedContext,
				proof: bindingOtpProof,
				verificationSucceeded: true,
			}),
		).resolves.toEqual({ kind: "IDENTITY_CONFLICT" });
		expect(
			database.calls.some((sql) =>
				sql.includes("record_otp_verification_attempt"),
			),
		).toBe(false);
	});

	it("charges an invalid EMAIL BIND attempt without querying identity ownership", async () => {
		let recordedValues: readonly unknown[] = [];
		const database = new ScriptedDatabase((text, values) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("record_otp_verification_attempt")) {
				recordedValues = values;
				return result({ changed: false });
			}
			throw new Error("invalid EMAIL code must not query identity ownership");
		});

		await expect(
			new PostgresAuthRepository(
				database as unknown as DatabasePool,
			).completeOtpBinding({
				session: authenticatedContext,
				proof: bindingOtpProof,
				verificationSucceeded: false,
			}),
		).resolves.toEqual({ kind: "INVALID_CREDENTIALS" });
		expect(recordedValues.at(-1)).toBe(false);
	});

	it("never invokes EMAIL bind when atomic consumption reports a replay", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("dedup_hash = $2")) return empty();
			if (
				text.includes("WHERE user_id = $1") &&
				text.includes("identity_type = 'EMAIL'")
			) {
				return empty();
			}
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: false });
			}
			throw new Error("replayed EMAIL proof must not bind");
		});

		await expect(
			new PostgresAuthRepository(
				database as unknown as DatabasePool,
			).completeOtpBinding({
				session: authenticatedContext,
				proof: bindingOtpProof,
				verificationSucceeded: true,
			}),
		).resolves.toEqual({ kind: "INVALID_CREDENTIALS" });
		expect(
			database.calls.some((sql) =>
				sql.includes("bind_email_identity_from_consumed_otp"),
			),
		).toBe(false);
	});

	it("allows only the caller that wins atomic EMAIL consumption to bind", async () => {
		const bindingId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		let consumeWon = false;
		let bindCalls = 0;
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("dedup_hash = $2")) return empty();
			if (
				text.includes("WHERE user_id = $1") &&
				text.includes("identity_type = 'EMAIL'")
			) {
				return empty();
			}
			if (text.includes("record_otp_verification_attempt")) {
				if (consumeWon) return result({ changed: false });
				consumeWon = true;
				return result({ changed: true });
			}
			if (text.includes("bind_email_identity_from_consumed_otp")) {
				bindCalls += 1;
				return result({ id: bindingId });
			}
			if (text.includes("WHERE id = $1 AND user_id = $2")) {
				return result({
					id: bindingId,
					identity_type: "EMAIL",
					masked_display_hint: "s*****t@example.com",
					is_primary: false,
					verified_at: new Date("2026-08-21T05:00:00.000Z"),
					revoked_at: null,
				});
			}
			throw new Error("unexpected concurrent EMAIL binding SQL");
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);

		const outcomes = await Promise.all([
			repository.completeOtpBinding({
				session: authenticatedContext,
				proof: bindingOtpProof,
				verificationSucceeded: true,
			}),
			repository.completeOtpBinding({
				session: authenticatedContext,
				proof: bindingOtpProof,
				verificationSucceeded: true,
			}),
		]);

		expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
			"INVALID_CREDENTIALS",
			"SUCCESS",
		]);
		expect(bindCalls).toBe(1);
	});

	it("throws after a consumed EMAIL proof when the bind primitive returns null so the transaction can roll back", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("dedup_hash = $2")) return empty();
			if (
				text.includes("WHERE user_id = $1") &&
				text.includes("identity_type = 'EMAIL'")
			) {
				return empty();
			}
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: true });
			}
			if (text.includes("bind_email_identity_from_consumed_otp")) {
				return result({ id: null });
			}
			throw new Error("unexpected EMAIL bind rollback SQL");
		});

		await expect(
			new PostgresAuthRepository(
				database as unknown as DatabasePool,
			).completeOtpBinding({
				session: authenticatedContext,
				proof: bindingOtpProof,
				verificationSucceeded: true,
			}),
		).rejects.toThrow("verified email binding did not complete");
		expect(
			database.calls.some((sql) =>
				sql.includes("record_otp_verification_attempt"),
			),
		).toBe(true);
	});

	it("uses the UnionID-aware primitive for a verified WeChat binding", async () => {
		const proof: OAuthProof = {
			...bindingOAuthProof,
			provider: "WECHAT",
		};
		const bindingId = "17171717-1717-4717-8717-171717171717";
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("consume_oauth_state_with_wechat_union")) {
				return result({ changed: true });
			}
			if (
				text.includes("FROM public.identity_bindings") &&
				(text.includes("dedup_hash = $2") || text.includes("lookup_hash = $2"))
			) {
				return empty();
			}
			if (
				text.includes(
					"bind_oauth_identity_with_wechat_union_from_consumed_state",
				)
			) {
				return result({ id: bindingId });
			}
			if (text.includes("WHERE id = $1 AND user_id = $2")) {
				return result({
					id: bindingId,
					identity_type: "WECHAT",
					masked_display_hint: "微信账号",
					is_primary: false,
					verified_at: new Date("2026-08-21T05:10:00.000Z"),
					revoked_at: null,
				});
			}
			throw new Error("unexpected WeChat binding SQL");
		});

		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOAuthBinding({
			session: authenticatedContext,
			proof,
			verifiedIdentity: verifiedWechatIdentity,
		});

		expect(outcome).toMatchObject({
			kind: "SUCCESS",
			binding: { bindingId, type: "WECHAT", canUnbind: true },
		});
		const consume = database.calls.findIndex((sql) =>
			sql.includes("consume_oauth_state_with_wechat_union"),
		);
		const bind = database.calls.findIndex((sql) =>
			sql.includes("bind_oauth_identity_with_wechat_union_from_consumed_state"),
		);
		expect(consume).toBeGreaterThan(-1);
		expect(consume).toBeLessThan(bind);
		expect(
			database.calls.some((sql) =>
				sql.includes("SELECT public.bind_oauth_identity_from_consumed_state"),
			),
		).toBe(false);
		expect(
			database.calls.some((sql) =>
				sql.includes("record_wechat_union_alias_from_consumed_state"),
			),
		).toBe(false);
	});

	it("keeps QQ binding on the legacy consume and binding primitives", async () => {
		const bindingId = "18181818-1818-4818-8818-181818181818";
		const verifiedQqIdentity = {
			lookup: { value: "7".repeat(64), keyVersion: "v1" },
			dedup: { value: "8".repeat(64), keyVersion: "stable-v1" },
			wechatUnionAlias: null,
		};
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("SELECT public.consume_oauth_state(")) {
				return result({ changed: true });
			}
			if (
				text.includes("FROM public.identity_bindings") &&
				(text.includes("dedup_hash = $2") || text.includes("lookup_hash = $2"))
			) {
				return empty();
			}
			if (
				text.includes("SELECT public.bind_oauth_identity_from_consumed_state")
			) {
				return result({ id: bindingId });
			}
			if (text.includes("WHERE id = $1 AND user_id = $2")) {
				return result({
					id: bindingId,
					identity_type: "QQ",
					masked_display_hint: "QQ 账号",
					is_primary: false,
					verified_at: new Date("2026-08-21T05:15:00.000Z"),
					revoked_at: null,
				});
			}
			throw new Error("unexpected QQ binding SQL");
		});

		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOAuthBinding({
			session: authenticatedContext,
			proof: bindingOAuthProof,
			verifiedIdentity: verifiedQqIdentity,
		});

		expect(outcome).toMatchObject({
			kind: "SUCCESS",
			binding: { bindingId, type: "QQ", canUnbind: true },
		});
		expect(
			database.calls.filter((sql) =>
				sql.includes("SELECT public.consume_oauth_state("),
			),
		).toHaveLength(1);
		expect(
			database.calls.filter((sql) =>
				sql.includes("SELECT public.bind_oauth_identity_from_consumed_state"),
			),
		).toHaveLength(1);
		expect(
			database.calls.some(
				(sql) =>
					sql.includes("consume_oauth_state_with_wechat_union") ||
					sql.includes(
						"bind_oauth_identity_with_wechat_union_from_consumed_state",
					) ||
					sql.includes("record_wechat_union_alias_from_consumed_state"),
			),
		).toBe(false);
	});

	it("never invokes QQ binding after an OAuth proof replay", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("consume_oauth_state")) {
				return result({ changed: false });
			}
			throw new Error("unexpected SQL after OAuth replay");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).completeOAuthBinding({
			session: authenticatedContext,
			proof: bindingOAuthProof,
			verifiedIdentity: verifiedWechatIdentity,
		});
		expect(outcome).toEqual({ kind: "INVALID_CREDENTIALS" });
		expect(
			database.calls.some((sql) =>
				sql.includes("bind_oauth_identity_from_consumed_state"),
			),
		).toBe(false);
	});

	it("returns the original timestamp for an idempotent non-primary unbind retry", async () => {
		const unboundAt = new Date("2026-08-21T05:35:00.000Z");
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("FROM public.identity_bindings")) {
				return result({
					id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
					identity_type: "QQ",
					masked_display_hint: "QQ 账号",
					is_primary: false,
					verified_at: new Date("2026-08-20T05:35:00.000Z"),
					revoked_at: unboundAt,
				});
			}
			throw new Error("revocation primitive must not run twice");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).unbindIdentity(
			authenticatedContext,
			"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		);
		expect(outcome).toEqual({ kind: "SUCCESS", unboundAt });
		expect(
			database.calls.some((sql) =>
				sql.includes("revoke_non_primary_identity_binding"),
			),
		).toBe(false);
	});

	it("revokes a same-account session and all of its access tokens in one transaction", async () => {
		const revokedAt = new Date("2026-08-21T05:40:00.000Z");
		const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (
				text.includes("FROM public.auth_session_families") &&
				text.includes("FOR UPDATE")
			) {
				return result({
					id: targetId,
					device_label: "Other device",
					platform: "ANDROID",
					created_at: new Date("2026-08-20T05:40:00.000Z"),
					last_seen_at: new Date("2026-08-21T05:30:00.000Z"),
					refresh_expires_at: new Date("2026-09-01T05:40:00.000Z"),
					status: "ACTIVE",
					revoked_at: null,
				});
			}
			if (text.includes("UPDATE public.auth_session_families")) {
				return result({ occurred_at: revokedAt });
			}
			if (text.includes("UPDATE public.auth_access_tokens")) return empty(2);
			throw new Error("unexpected session revocation SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).revokeSession(authenticatedContext, targetId);
		expect(outcome).toEqual({ kind: "SUCCESS", revokedAt });
		const family = database.calls.findIndex((sql) =>
			sql.includes("UPDATE public.auth_session_families"),
		);
		const access = database.calls.findIndex((sql) =>
			sql.includes("UPDATE public.auth_access_tokens"),
		);
		expect(family).toBeLessThan(access);
	});

	it("serializes concurrent export retries to one durable job", async () => {
		const database = new ExportQueueDatabase();
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const outcomes = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				repository.queueDataExport(authenticatedContext, {
					exportId: `eeeeeeee-eeee-4eee-8eee-${index.toString().padStart(12, "0")}`,
					includeBehaviorHistory: true,
				}),
			),
		);
		expect(outcomes.every((outcome) => outcome.kind === "SUCCESS")).toBe(true);
		expect(
			new Set(
				outcomes.map((outcome) =>
					outcome.kind === "SUCCESS" ? outcome.exportId : "failure",
				),
			).size,
		).toBe(1);
		expect(
			database.calls.filter((sql) => sql.includes("app_queue_data_export")),
		).toHaveLength(12);
		expect(database.calls.join("\n")).not.toMatch(
			/(?:FROM|INSERT INTO|UPDATE|DELETE FROM) public\.data_export_jobs/iu,
		);
	});

	it("reads export status only through the owner-scoped database function", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("app_get_data_export_status")) {
				return result({
					export_id: "cbf405ae-82a1-4f87-86b7-1c97c4a8683f",
					export_status: "READY",
					requested_at: new Date("2026-08-21T05:20:00.000Z"),
					ready_at: new Date("2026-08-21T05:21:00.000Z"),
					expires_at: new Date("2026-08-28T05:21:00.000Z"),
					include_behavior_history: false,
					failure_code: null,
					artifact_size_bytes: "2048",
					artifact_sha256: "a".repeat(64),
				});
			}
			throw new Error("unexpected export status SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).readDataExport(
			authenticatedContext,
			"cbf405ae-82a1-4f87-86b7-1c97c4a8683f",
		);
		expect(outcome).toMatchObject({
			kind: "SUCCESS",
			record: {
				status: "READY",
				artifactSizeBytes: 2_048,
				artifactSha256: "a".repeat(64),
				includeBehaviorHistory: false,
			},
		});
		expect(database.calls.join("\n")).not.toContain(
			"FROM public.data_export_jobs",
		);
	});

	it("opens only a server-internal encrypted artifact authorization", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("app_open_data_export_artifact")) {
				return result({
					artifact_locator_ciphertext: Buffer.from("opaque-ciphertext"),
					artifact_encryption_key_version: "v1",
					artifact_size_bytes: 42,
					artifact_sha256: "b".repeat(64),
					artifact_content_type: "application/json",
				});
			}
			throw new Error("unexpected export artifact SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).openDataExportArtifact(
			authenticatedContext,
			"cbf405ae-82a1-4f87-86b7-1c97c4a8683f",
		);
		expect(outcome).toEqual({
			kind: "SUCCESS",
			artifact: {
				locatorCiphertext: Buffer.from("opaque-ciphertext"),
				locatorKeyVersion: "v1",
				sizeBytes: 42,
				sha256: "b".repeat(64),
				contentType: "application/json",
			},
		});
	});

	it("starts deletion through the restricted primitive and returns database timestamps", async () => {
		const requestedAt = new Date("2026-08-21T05:45:00.000Z");
		const purgeDueAt = new Date("2026-09-20T05:45:00.000Z");
		const database = new ScriptedDatabase((text) => {
			if (text.includes("pg_advisory_xact_lock")) return empty();
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("begin_account_deletion")) {
				return result({ changed: true });
			}
			if (text.includes("FROM public.account_deletion_jobs")) {
				return result({
					requested_at: requestedAt,
					purge_due_at: purgeDueAt,
				});
			}
			throw new Error("unexpected account deletion SQL");
		});
		const outcome = await new PostgresAuthRepository(
			database as unknown as DatabasePool,
		).beginAccountDeletion(authenticatedContext, {
			deletionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			subjectHash: { value: "9".repeat(64), keyVersion: "v1" },
			purgeDueAt,
		});
		expect(outcome).toEqual({ kind: "SUCCESS", requestedAt, purgeDueAt });
		expect(
			database.calls.some((sql) => sql.includes("begin_account_deletion")),
		).toBe(true);
	});
});

function result<Row extends QueryResultRow>(row: Row): SqlResult<Row> {
	return { rows: [row], rowCount: 1 };
}

function empty<Row extends QueryResultRow>(rowCount = 0): SqlResult<Row> {
	return { rows: [], rowCount };
}
