import type {
	RecommendationContext,
	RecommendationResponse,
	RecommendationResult,
} from "./types";

declare function setTimeout(callback: () => void, delayMs: number): unknown;
declare function clearTimeout(timer: unknown): void;

export type ResultSessionState = "CURRENT" | "CONFIG_UNCONFIRMED" | "EXPIRED";
export type ResultExpiryScheduler = (
	onExpire: () => void,
	delayMs: number,
) => () => void;

interface ResultSession {
	readonly receivedAtMs: number;
	readonly expiresAtMs: number;
	readonly response: RecommendationResponse;
	readonly context: RecommendationContext;
	readonly configurationGeneration: number;
	readonly trustedCompatibleConfiguration: boolean;
}

export class ResultSessionStore {
	private session: ResultSession | null = null;
	private selectedResultToken: string | null = null;
	private activeConfigurationGeneration = 0;
	private configurationState: ResultSessionState = "CONFIG_UNCONFIRMED";
	private lastObservedWallMs = 0;
	private cancelExpiry: (() => void) | null = null;
	constructor(
		private readonly now: () => Date = () => new Date(),
		private readonly scheduleExpiry: ResultExpiryScheduler = scheduleResultExpiry,
	) {}

	markConfigurationUnconfirmed(generation: number): void {
		this.activeConfigurationGeneration = generation;
		this.configurationState = "CONFIG_UNCONFIRMED";
		this.selectedResultToken = null;
	}

	confirmConfiguration(generation: number): void {
		this.activeConfigurationGeneration = generation;
		this.configurationState = "CURRENT";
		if (
			this.session !== null &&
			this.session.configurationGeneration !== generation
		) {
			this.clearResult();
		}
		this.selectedResultToken = null;
	}

	markConfigurationUnavailable(generation: number): void {
		this.activeConfigurationGeneration = generation;
		this.configurationState = "EXPIRED";
		this.clearResult();
	}

	install(
		response: RecommendationResponse,
		context: RecommendationContext,
		configurationGeneration: number,
		trustedCompatibleConfiguration: boolean,
	): void {
		this.clearResult();
		const receivedAtMs = this.now().getTime();
		const generatedAtMs = Date.parse(response.generatedAt);
		this.lastObservedWallMs = receivedAtMs;
		this.session = {
			receivedAtMs,
			expiresAtMs: Math.min(receivedAtMs, generatedAtMs) + 2 * 60 * 60 * 1_000,
			response,
			context,
			configurationGeneration,
			trustedCompatibleConfiguration,
		};
		const session = this.session;
		const remaining = session.expiresAtMs - receivedAtMs;
		if (!Number.isFinite(remaining) || remaining <= 0) {
			this.clearResult();
			return;
		}
		this.cancelExpiry = this.scheduleExpiry(
			() => {
				if (this.session === session) this.clearResult();
			},
			Math.min(remaining, 2 * 60 * 60 * 1_000),
		);
		this.selectedResultToken = null;
	}

	state(resultToken: string): ResultSessionState {
		if (this.configurationState !== "CURRENT") return this.configurationState;
		const session = this.freshSession();
		if (
			session === null ||
			!session.trustedCompatibleConfiguration ||
			session.configurationGeneration !== this.activeConfigurationGeneration ||
			!session.response.results.some(
				(result) => result.resultToken === resultToken,
			)
		) {
			return "EXPIRED";
		}
		return "CURRENT";
	}

	select(resultToken: string): boolean {
		if (this.state(resultToken) !== "CURRENT") return false;
		this.selectedResultToken = resultToken;
		return true;
	}

	selected(): RecommendationResult | null {
		const token = this.selectedResultToken;
		if (token === null || this.state(token) !== "CURRENT") {
			this.selectedResultToken = null;
			return null;
		}
		return (
			this.session?.response.results.find(
				(result) => result.resultToken === token,
			) ?? null
		);
	}

	result(resultToken: string): RecommendationResult | null {
		if (this.state(resultToken) !== "CURRENT") return null;
		return (
			this.session?.response.results.find(
				(result) => result.resultToken === resultToken,
			) ?? null
		);
	}

	currentResponse(): RecommendationResponse | null {
		return this.freshSession()?.response ?? null;
	}

	clearResult(): void {
		this.cancelExpiry?.();
		this.cancelExpiry = null;
		this.session = null;
		this.selectedResultToken = null;
	}

	private freshSession(): ResultSession | null {
		const session = this.session;
		if (session === null) return null;
		const current = this.now().getTime();
		if (
			!Number.isFinite(current) ||
			!Number.isFinite(session.expiresAtMs) ||
			current < this.lastObservedWallMs ||
			current >= session.expiresAtMs
		) {
			this.clearResult();
			return null;
		}
		this.lastObservedWallMs = current;
		return session;
	}

	clearSelection(): void {
		this.selectedResultToken = null;
	}

	expire(): void {
		this.configurationState = "EXPIRED";
		this.clearResult();
	}
}

function scheduleResultExpiry(
	onExpire: () => void,
	delayMs: number,
): () => void {
	const timer = setTimeout(onExpire, delayMs);
	// Node test timers must not keep the worker alive; WeChat returns a number.
	if (
		typeof timer === "object" &&
		timer !== null &&
		"unref" in timer &&
		typeof timer.unref === "function"
	)
		timer.unref();
	return () => clearTimeout(timer);
}
