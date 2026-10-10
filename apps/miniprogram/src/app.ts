import { resolveRuntimeConfig } from "./config/runtime";
import { AccountExportDownloader } from "./core/account-export";
import { HttpApi, WechatMiniProgramApi } from "./core/api-client";
import { AuthSessionService } from "./core/auth-session";
import { createRandomUuid, InstallationStore } from "./core/installation";
import { RefreshSessionStore } from "./core/session-store";
import {
	FeatureConfigService,
	type FeatureConfigState,
} from "./features/config/feature-config";
import { evaluateVersion } from "./features/config/version-policy";
import { PrivacyConsentAuthority } from "./features/consent/consent-authority";
import {
	createDecisionFeature,
	type DecisionFeature,
	type DecisionFeatureRuntime,
	installDecisionFeature,
} from "./features/decision/index";
import {
	HttpFeatureConfigSource,
	HttpSavedResourcesApi,
	HttpSupportFeedbackApi,
} from "./features/integration/api-adapters";
import { SavedResourcesService } from "./features/persistence/saved-resources";
import { LocalPreferences } from "./features/settings/local-preferences";
import { SupportFeedbackService } from "./features/support/support-feedback";

export type RemoteInitializationResult =
	| Readonly<{
			kind: "READY";
			config: Extract<FeatureConfigState, { kind: "READY" }>["config"];
	  }>
	| Readonly<{ kind: "UPDATE_REQUIRED"; minimumVersion: string }>
	| Readonly<{ kind: "UNAVAILABLE" }>
	| Readonly<{ kind: "PRIVACY_REQUIRED" }>;

export interface ChiShenMeMiniProgramApp {
	readonly onShow: () => void;
	readonly onHide: () => void;
	readonly globalData: {
		readonly auth: AuthSessionService;
		readonly http: HttpApi;
		readonly apiBaseUrl: string;
		readonly exportDownloader: AccountExportDownloader;
		readonly consent: PrivacyConsentAuthority;
		readonly preferences: LocalPreferences;
		readonly featureConfig: FeatureConfigService;
		readonly decision: DecisionFeature;
		readonly saved: SavedResourcesService;
		readonly support: SupportFeedbackService;
		readonly acceptPrivacy: () => boolean;
		readonly initializeAfterConsent: () => Promise<RemoteInitializationResult>;
		readonly withdrawPrivacy: () => boolean;
	};
}

const config = resolveRuntimeConfig(wx);
const consent = new PrivacyConsentAuthority(wx);
const preferences = new LocalPreferences(wx);
let foreground = true;
const http = new HttpApi(wx, config.apiBaseUrl, () => foreground && consent.isAllowed());
const featureConfig = new FeatureConfigService(
	new HttpFeatureConfigSource(http),
);
let generation = 0;
let remoteEnabled = false;
let initialization: Promise<RemoteInitializationResult> | null = null;
let authRestoreAttempted = false;
let requiredMinimumVersion: string | null = null;
const exportDownloader = new AccountExportDownloader(
	wx,
	config.apiBaseUrl,
	() => {
		if (!consent.isAllowed() || !remoteEnabled) return false;
		const state = featureConfig.current();
		return (
			state.kind === "READY" &&
			state.config.authCapabilities.accountsEnabled &&
			state.config.authCapabilities.dataExportEnabled
		);
	},
);
const authApi = new WechatMiniProgramApi(http);
const sessionStorage = new RefreshSessionStore(wx);
const installation = new InstallationStore(wx, wx, () => consent.isAllowed());
const auth = new AuthSessionService(
	authApi,
	wx,
	installation,
	sessionStorage,
	config.appVersion,
	() => {
		if (!remoteEnabled) return null;
		const state = featureConfig.current();
		return state.kind === "READY" ? state.config.authCapabilities : null;
	},
);
const decision = createDecisionFeature({
	runtime: wx as unknown as DecisionFeatureRuntime,
	apiBaseUrl: config.apiBaseUrl,
	accessToken: () => auth.currentAccessToken(),
	remoteAccessAllowed: () => foreground && consent.isAllowed(),
});
installDecisionFeature(decision);

const saved = new SavedResourcesService(
	new HttpSavedResourcesApi(http),
	{
		accessToken: () => auth.accessToken(),
		invalidate: () => auth.invalidate(),
	},
	consent,
	() => {
		if (!remoteEnabled) return null;
		const state = featureConfig.current();
		return state.kind === "READY" ? state.config.persistenceCapabilities : null;
	},
	() => createRandomUuid(wx),
);

const support = new SupportFeedbackService(
	new HttpSupportFeedbackApi(http),
	{ accessToken: () => auth.accessToken() },
	consent,
	() => {
		const state = featureConfig.current();
		return (
			remoteEnabled &&
			state.kind === "READY" &&
			state.config.supportFeedbackEnabled
		);
	},
	() => createRandomUuid(wx),
);

async function initializeAfterConsent(): Promise<RemoteInitializationResult> {
	if (!foreground || !consent.isAllowed()) return Object.freeze({ kind: "PRIVACY_REQUIRED" });
	if (initialization !== null) return initialization;
	const operation = initializeRemote();
	initialization = operation;
	try {
		return await operation;
	} finally {
		if (initialization === operation) initialization = null;
	}
}

async function initializeRemote(): Promise<RemoteInitializationResult> {
	remoteEnabled = false;
	const currentGeneration = ++generation;
	http.abortAll();
	exportDownloader.abortAll();
	decision.cancelRemoteRequests();
	decision.controller.beginConfigurationRefresh(currentGeneration);
	featureConfig.revoke();
	const state = await featureConfig.refresh();
	if (!foreground || !consent.isAllowed() || currentGeneration !== generation) {
		return Object.freeze({ kind: "PRIVACY_REQUIRED" });
	}
	if (state.kind !== "READY") {
		decision.controller.setAccessPolicy({
			generation: currentGeneration,
			state: "UNCONFIRMED",
			recommendationsEnabled: false,
			locationSearchEnabled: false,
			aiEnabled: false,
		});
		return unavailableResult();
	}
	const version = evaluateVersion(
		config.appVersion,
		// The legacy scalar belongs to Android. Missing mini-program policy uses
		// the first shipped mini-program baseline; it cannot borrow Android's gate.
		state.config.minimumSupportedVersions?.miniprogram ?? "0.1.0",
	);
	if (version.kind === "UPDATE_REQUIRED") {
		requiredMinimumVersion = version.minimumVersion;
		featureConfig.revoke();
		decision.controller.setAccessPolicy({
			generation: currentGeneration,
			state: "INCOMPATIBLE",
			recommendationsEnabled: false,
			locationSearchEnabled: false,
			aiEnabled: false,
		});
		return Object.freeze({
			kind: "UPDATE_REQUIRED",
			minimumVersion: version.minimumVersion,
		});
	}
	if (version.kind !== "COMPATIBLE") {
		featureConfig.revoke();
		decision.controller.setAccessPolicy({
			generation: currentGeneration,
			state: "UNCONFIRMED",
			recommendationsEnabled: false,
			locationSearchEnabled: false,
			aiEnabled: false,
		});
		return unavailableResult();
	}
	requiredMinimumVersion = null;
	remoteEnabled = true;
	decision.controller.setAccessPolicy({
		generation: currentGeneration,
		state: "TRUSTED_COMPATIBLE",
		recommendationsEnabled:
			state.config.serviceCapabilities.recommendationsEnabled,
		locationSearchEnabled:
			state.config.serviceCapabilities.locationSearchEnabled,
		aiEnabled: state.config.aiEnabled,
		recommendationDefaults: state.config.recommendationDefaults,
		specialtyCapabilities: state.config.specialtyCapabilities,
		dataRightsMode: state.config.dataRightsMode,
	});
	decision.controller.setAiAssistancePreferred(
		state.config.aiEnabled && preferences.aiAssistanceEnabled(),
	);
	if (state.config.dataRightsMode === "LICENSED_ENRICHMENT") {
		const vector = preferences.preferenceVector();
		for (const key of ["quality", "time", "budget", "mealMatch", "diversity"] as const) {
			if (decision.controller.state.form.preferenceVector[key] !== vector[key]) {
				decision.controller.setPreferenceWeight(key, vector[key]);
			}
		}
	}
	if (state.config.authCapabilities.accountsEnabled && !authRestoreAttempted) {
		authRestoreAttempted = true;
		const restored = await auth
			.restore()
			.catch(() => ({ kind: "ERROR" as const, retryable: true }));
		if (restored.kind === "ERROR") authRestoreAttempted = false;
	} else {
		if (!state.config.authCapabilities.accountsEnabled) {
			authRestoreAttempted = true;
			auth.invalidate();
		}
	}
	if (!foreground || !consent.isAllowed() || currentGeneration !== generation) {
		return Object.freeze({ kind: "PRIVACY_REQUIRED" });
	}
	return Object.freeze({ kind: "READY", config: state.config });
}

function unavailableResult(): RemoteInitializationResult {
	return requiredMinimumVersion === null
		? Object.freeze({ kind: "UNAVAILABLE" })
		: Object.freeze({ kind: "UPDATE_REQUIRED", minimumVersion: requiredMinimumVersion });
}

function clearSensitiveLocalState(): void {
	let cleanupFailed = false;
	for (const clear of [
		() => http.abortAll(),
		() => exportDownloader.abortAll(),
		() => auth.invalidate(),
		() => installation.clear(),
		() => preferences.clearSensitiveState(),
		() => decision.controller.clearSensitiveState(),
	]) {
		try {
			clear();
		} catch {
			cleanupFailed = true;
		}
	}
	if (cleanupFailed) throw new Error("PRIVACY_LOCAL_CLEANUP_INCOMPLETE");
}

function acceptPrivacy(): boolean {
	return consent.accept(new Date(), clearSensitiveLocalState);
}

function withdrawPrivacy(): boolean {
	remoteEnabled = false;
	initialization = null;
	authRestoreAttempted = false;
	decision.cancelRemoteRequests();
	decision.controller.beginConfigurationRefresh(++generation);
	featureConfig.revoke();
	return consent.withdraw(clearSensitiveLocalState);
}

App<ChiShenMeMiniProgramApp>({
	onShow() {
		foreground = true;
		if (!consent.isAllowed()) return;
		void initializeAfterConsent().then((result) => {
			if (result.kind === "UPDATE_REQUIRED") {
				wx.reLaunch({
					url: `/pages/update/index?minimumVersion=${encodeURIComponent(result.minimumVersion)}`,
				});
			} else if (result.kind === "READY") {
				const pages = getCurrentPages();
				const current = pages[pages.length - 1];
				if (current?.route === "pages/update/index") {
					wx.reLaunch({ url: "/pages/home/index" });
				}
			}
		});
	},
	onHide() {
		foreground = false;
		remoteEnabled = false;
		initialization = null;
		authRestoreAttempted = false;
		++generation;
		http.abortAll();
		exportDownloader.abortAll();
		decision.cancelRemoteRequests();
		decision.controller.beginConfigurationRefresh(generation);
		decision.controller.clearSensitiveState();
		featureConfig.revoke();
		auth.suspend();
	},
	globalData: {
		auth,
		http,
		apiBaseUrl: config.apiBaseUrl,
		exportDownloader,
		consent,
		preferences,
		featureConfig,
		decision,
		saved,
		support,
		acceptPrivacy,
		initializeAfterConsent,
		withdrawPrivacy,
	},
});
