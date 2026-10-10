import {
	DetailActionExecutor,
	type DetailActionRuntime,
} from "./action-policy";
import { type DecisionHttpRuntime, StrictDecisionApiClient } from "./api";
import { DecisionController } from "./controller";
import {
	type LocationProvider,
	WechatForegroundLocationProvider,
	type WechatLocationRuntime,
} from "./location";
import { ResultSessionStore } from "./session";

export interface DecisionFeatureRuntime
	extends DecisionHttpRuntime,
		WechatLocationRuntime,
		DetailActionRuntime {}

export interface DecisionFeature {
	readonly controller: DecisionController;
	readonly sessions: ResultSessionStore;
	readonly actions: DetailActionExecutor;
	readonly cancelRemoteRequests: () => void;
}

export interface CreateDecisionFeatureOptions {
	readonly runtime: DecisionFeatureRuntime;
	readonly apiBaseUrl: string;
	readonly accessToken?: () => string | null;
	readonly remoteAccessAllowed?: () => boolean;
	readonly locationProvider?: LocationProvider;
	readonly now?: () => Date;
}

let installedFeature: DecisionFeature | null = null;

export function createDecisionFeature(
	options: CreateDecisionFeatureOptions,
): DecisionFeature {
	const sessions = new ResultSessionStore(options.now);
	const api = new StrictDecisionApiClient(
		options.runtime,
		options.apiBaseUrl,
		options.accessToken ?? (() => null),
		options.remoteAccessAllowed ?? (() => true),
	);
	const controller = new DecisionController(
		api,
		options.locationProvider ??
			new WechatForegroundLocationProvider(
				options.runtime,
				options.remoteAccessAllowed ?? (() => true),
			),
		sessions,
		options.now ?? (() => new Date()),
	);
	const actions = new DetailActionExecutor(options.runtime, sessions, {
		record: (type, resultToken) => controller.record(type, resultToken),
	});
	return Object.freeze({
		controller,
		sessions,
		actions,
		cancelRemoteRequests: () => api.abortAll(),
	});
}

export function installDecisionFeature(feature: DecisionFeature): void {
	installedFeature = feature;
}

export function requireDecisionFeature(): DecisionFeature {
	if (installedFeature === null) {
		throw new Error("DECISION_FEATURE_NOT_INSTALLED");
	}
	return installedFeature;
}

export function resetDecisionFeatureForTests(): void {
	installedFeature?.controller.dispose();
	installedFeature = null;
}
