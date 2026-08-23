import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
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
	purpose: "REGISTER" | "LOGIN",
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
		codeHash: { value: "encoded-argon-hash", keyVersion: "pepper-v1" },
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

class RollbackDatabase {
	readonly calls: string[] = [];
	committed = false;
	rolledBack = false;
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
		try {
			const value = await work({
				query: async <Row extends QueryResultRow>(
					text: string,
					values: readonly unknown[] = [],
				) => {
					this.calls.push(text);
					return this.answer(text, values) as SqlResult<Row>;
				},
			});
			this.committed = true;
			return value;
		} catch (error) {
			this.rolledBack = true;
			throw error;
		}
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
	codeHash: "encoded-argon-hash",
	codeHashKeyVersion: "pepper-v1",
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

const registrationOAuthProof: OAuthProof = {
	id: "66666666-6666-4666-8666-666666666666",
	provider: "WECHAT",
	purpose: "REGISTER",
	flowReferenceHash: "f".repeat(64),
	operationTargetHash: null,
	targetUserId: null,
	deviceHash: registrationOtpProof.deviceHash,
	hashKeyVersion: "v1",
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
	operationTargetHash: "6".repeat(64),
	targetUserId: authenticatedContext.userId,
	deviceHash: authenticatedContext.deviceHash,
};

const bindingOAuthProof: OAuthProof = {
	...registrationOAuthProof,
	provider: "QQ",
	purpose: "BIND",
	operationTargetHash: "7".repeat(64),
	targetUserId: authenticatedContext.userId,
	deviceHash: authenticatedContext.deviceHash,
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
		const database = new ScriptedDatabase((text) => {
			if (text.includes("pg_advisory_xact_lock")) return empty();
			if (text.includes("SELECT id, masked_destination, expires_at")) {
				return empty();
			}
			if (text.includes("destination_day_count")) {
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

	it("allows bounded registration state retries and rejects the fourth", async () => {
		const database = new OAuthLimitDatabase();
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const outcomes = [];
		for (let index = 1; index <= 4; index += 1) {
			outcomes.push(
				await repository.createOAuthState(oauthDraft(index, "REGISTER")),
			);
		}
		expect(outcomes.map((outcome) => outcome.kind)).toEqual([
			"CREATED",
			"CREATED",
			"CREATED",
			"RATE_LIMITED",
		]);
		expect(database.rows).toHaveLength(3);
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

	it("commits a failed OTP attempt without resolving an identity or issuing tokens", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("record_otp_verification_attempt")) {
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
		});
		expect(completion).toEqual({ kind: "INVALID_CREDENTIALS" });
		expect(database.calls).toHaveLength(1);
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

	it("atomically consumes both registration proofs before creating the account and session", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: true });
			}
			if (text.includes("consume_oauth_state")) {
				return result({ changed: true });
			}
			if (text.includes("SELECT binding.user_id")) return empty();
			if (text.includes("register_phone_wechat_account")) {
				return result({ changed: true });
			}
			if (text.includes("INSERT INTO public.auth_")) return empty(1);
			throw new Error("unexpected registration SQL");
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const outcome = await repository.completeRegistration({
			newUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			otpProof: registrationOtpProof,
			otpVerificationSucceeded: true,
			oauthProof: registrationOAuthProof,
			verifiedWechatIdentity,
			session: sessionDraft,
		});
		expect(outcome).toEqual({
			kind: "SUCCESS",
			userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			sessionId: sessionDraft.sessionId,
		});
		const orderedFragments = [
			"record_otp_verification_attempt",
			"consume_oauth_state",
			"SELECT binding.user_id",
			"register_phone_wechat_account",
			"INSERT INTO public.auth_session_families",
			"INSERT INTO public.auth_refresh_credentials",
			"INSERT INTO public.auth_access_tokens",
		];
		const indexes = orderedFragments.map((fragment) =>
			database.calls.findIndex((sql) => sql.includes(fragment)),
		);
		expect(indexes.every((index) => index >= 0)).toBe(true);
		expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
	});

	it("returns an identity conflict before account or session creation", async () => {
		const database = new ScriptedDatabase((text) => {
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: true });
			}
			if (text.includes("consume_oauth_state")) {
				return result({ changed: true });
			}
			if (text.includes("SELECT binding.user_id")) {
				return result({ user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
			}
			throw new Error("unexpected SQL after identity conflict");
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		const outcome = await repository.completeRegistration({
			newUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			otpProof: registrationOtpProof,
			otpVerificationSucceeded: true,
			oauthProof: registrationOAuthProof,
			verifiedWechatIdentity,
			session: sessionDraft,
		});
		expect(outcome).toEqual({ kind: "IDENTITY_CONFLICT" });
		expect(
			database.calls.some((sql) =>
				sql.includes("register_phone_wechat_account"),
			),
		).toBe(false);
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.auth_session_families"),
			),
		).toBe(false);
	});

	it("rolls back both consumed registration proofs when account creation fails", async () => {
		const database = new RollbackDatabase((text) => {
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: true });
			}
			if (text.includes("consume_oauth_state")) {
				return result({ changed: true });
			}
			if (text.includes("SELECT binding.user_id")) return empty();
			if (text.includes("register_phone_wechat_account")) {
				throw new Error("simulated account creation failure");
			}
			throw new Error("unexpected SQL after account creation failure");
		});
		const repository = new PostgresAuthRepository(
			database as unknown as DatabasePool,
		);
		await expect(
			repository.completeRegistration({
				newUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				otpProof: registrationOtpProof,
				otpVerificationSucceeded: true,
				oauthProof: registrationOAuthProof,
				verifiedWechatIdentity,
				session: sessionDraft,
			}),
		).rejects.toThrow("simulated account creation failure");
		expect(database.rolledBack).toBe(true);
		expect(database.committed).toBe(false);
		expect(
			database.calls.some((sql) =>
				sql.includes("INSERT INTO public.auth_session_families"),
			),
		).toBe(false);
	});

	it("atomically consumes an EMAIL BIND proof before invoking the restricted binding primitive", async () => {
		const bindingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const database = new ScriptedDatabase((text) => {
			if (text.includes("SELECT family.id")) {
				return result({ id: authenticatedContext.sessionId });
			}
			if (text.includes("record_otp_verification_attempt")) {
				return result({ changed: true });
			}
			if (
				text.includes("FROM public.identity_bindings") &&
				text.includes("dedup_hash")
			) {
				return empty();
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
		const bind = database.calls.findIndex((sql) =>
			sql.includes("bind_email_identity_from_consumed_otp"),
		);
		expect(consume).toBeGreaterThan(-1);
		expect(consume).toBeLessThan(bind);
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
				sql.includes("bind_qq_identity_from_consumed_oauth_state"),
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
