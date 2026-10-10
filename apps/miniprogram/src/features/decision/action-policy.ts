import { toGcj02 } from "./coordinate";
import type { ResultSessionState, ResultSessionStore } from "./session";
import type { RecommendationResult } from "./types";

export type RestaurantAction = "NAVIGATE" | "CALL" | "COPY_ADDRESS" | "SHARE";

export type ActionUnavailableReason =
	| "SOURCE_NOT_ENABLED"
	| "CONFIG_UNCONFIRMED"
	| "SESSION_EXPIRED"
	| "MISSING_NAVIGATION_FACTS"
	| "MISSING_PHONE"
	| "MISSING_ADDRESS"
	| "CLIENT_FEATURE_DISABLED";

export interface ActionStatus {
	readonly enabled: boolean;
	readonly unavailableReason: ActionUnavailableReason | null;
}

export interface RestaurantActionAvailability {
	readonly navigate: ActionStatus;
	readonly call: ActionStatus;
	readonly copyAddress: ActionStatus;
	readonly share: ActionStatus;
}

export function evaluateRestaurantActions(
	result: RecommendationResult,
	sessionState: ResultSessionState,
): RestaurantActionAvailability {
	return Object.freeze({
		navigate: status(
			sessionState,
			result.actions.navigate,
			hasText(result.name) || hasText(result.address),
			"MISSING_NAVIGATION_FACTS",
		),
		call: status(
			sessionState,
			result.actions.call,
			hasCallableNumber(result.phone),
			"MISSING_PHONE",
		),
		copyAddress: status(
			sessionState,
			result.actions.copyAddress,
			hasText(result.address),
			"MISSING_ADDRESS",
		),
		// Product decision: share is closed in the Mini Program just as it is in Android 1.0.
		share: disabled("CLIENT_FEATURE_DISABLED"),
	});
}

export interface DetailActionRuntime {
	openLocation(options: {
		readonly latitude: number;
		readonly longitude: number;
		readonly name: string;
		readonly address: string;
		readonly scale: number;
		readonly success: () => void;
		readonly fail: () => void;
	}): void;
	makePhoneCall(options: {
		readonly phoneNumber: string;
		readonly success: () => void;
		readonly fail: () => void;
	}): void;
	setClipboardData(options: {
		readonly data: string;
		readonly success: () => void;
		readonly fail: () => void;
	}): void;
}

export interface DetailActionEventSink {
	record(type: "NAVIGATION" | "CALL", resultToken: string): void;
}

export class DetailActionExecutor {
	constructor(
		private readonly runtime: DetailActionRuntime,
		private readonly sessions: ResultSessionStore,
		private readonly events: DetailActionEventSink,
	) {}

	navigate(resultToken: string): Promise<boolean> {
		return this.execute(
			resultToken,
			"NAVIGATE",
			(result) =>
				new Promise<boolean>((resolve) => {
					const coordinate = toGcj02(result.location);
					if (coordinate === null) {
						resolve(false);
						return;
					}
					// Session and server action capability were rechecked immediately above.
					this.runtime.openLocation({
						latitude: coordinate.latitude,
						longitude: coordinate.longitude,
						name: result.name.trim(),
						address: result.address.trim(),
						scale: 16,
						success: () => {
							this.events.record("NAVIGATION", result.resultToken);
							resolve(true);
						},
						fail: () => resolve(false),
					});
				}),
		);
	}

	call(resultToken: string): Promise<boolean> {
		return this.execute(
			resultToken,
			"CALL",
			(result) =>
				new Promise<boolean>((resolve) => {
					this.runtime.makePhoneCall({
						phoneNumber: result.phone?.trim() ?? "",
						success: () => {
							this.events.record("CALL", result.resultToken);
							resolve(true);
						},
						fail: () => resolve(false),
					});
				}),
		);
	}

	copyAddress(resultToken: string): Promise<boolean> {
		return this.execute(
			resultToken,
			"COPY_ADDRESS",
			(result) =>
				new Promise<boolean>((resolve) => {
					this.runtime.setClipboardData({
						data: result.address.trim(),
						success: () => resolve(true),
						fail: () => resolve(false),
					});
				}),
		);
	}

	share(): Promise<boolean> {
		return Promise.resolve(false);
	}

	private execute(
		resultToken: string,
		action: Exclude<RestaurantAction, "SHARE">,
		invoke: (result: RecommendationResult) => Promise<boolean>,
	): Promise<boolean> {
		const result = this.sessions.result(resultToken);
		if (result === null) return Promise.resolve(false);
		const availability = evaluateRestaurantActions(
			result,
			this.sessions.state(resultToken),
		);
		const allowed =
			action === "NAVIGATE"
				? availability.navigate.enabled
				: action === "CALL"
					? availability.call.enabled
					: availability.copyAddress.enabled;
		return allowed ? invoke(result) : Promise.resolve(false);
	}
}

function status(
	sessionState: ResultSessionState,
	serverEnabled: boolean,
	hasFacts: boolean,
	missingReason: ActionUnavailableReason,
): ActionStatus {
	if (sessionState === "CONFIG_UNCONFIRMED")
		return disabled("CONFIG_UNCONFIRMED");
	if (sessionState !== "CURRENT") return disabled("SESSION_EXPIRED");
	if (!serverEnabled) return disabled("SOURCE_NOT_ENABLED");
	if (!hasFacts) return disabled(missingReason);
	return Object.freeze({ enabled: true, unavailableReason: null });
}

function disabled(reason: ActionUnavailableReason): ActionStatus {
	return Object.freeze({ enabled: false, unavailableReason: reason });
}

function hasText(value: string | null): boolean {
	return value !== null && value.trim().length !== 0;
}

function hasCallableNumber(value: string | null): boolean {
	return (
		value
			?.trim()
			.split("")
			.some((character) => /\d/u.test(character)) ?? false
	);
}
