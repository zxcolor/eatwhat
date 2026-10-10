import { applyPageTheme, themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import type { ThemePreference } from "../../features/settings/local-preferences";
import { requireDecisionFeature } from "../../features/decision/index";

const WEIGHT_OPTIONS = [
	{ key: "quality", label: "质量信号" },
	{ key: "time", label: "用时" },
	{ key: "budget", label: "预算" },
	{ key: "mealMatch", label: "餐段匹配" },
	{ key: "diversity", label: "多样性" },
] as const;

const THEME_OPTIONS: readonly Readonly<{
	value: ThemePreference;
	label: string;
}>[] = [
	{ value: "SYSTEM", label: "跟随系统" },
	{ value: "LIGHT", label: "浅色" },
	{ value: "DARK", label: "深色" },
];

interface SwitchEvent {
	readonly detail: { readonly value: boolean };
}

themedPage({
	data: {
		aiEnabled: false,
		aiServiceAvailable: false,
		supportFeedbackEnabled: false,
		savedResourcesEnabled: false,
		themeOptions: THEME_OPTIONS,
		themeIndex: 0,
		history: [] as readonly Record<string, unknown>[],
		document: "" as
			| ""
			| "PRIVACY"
			| "SOURCES"
			| "ALGORITHM"
			| "SERVICES"
			| "HELP"
			| "VERSION",
		versionMessage: "远程版本要求尚未确认",
		preferenceEditable: false,
		preferenceStored: false,
		weights: [] as readonly { key: string; label: string; value: number }[],
	},

	async onLoad() {
		wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		if (!app.consent.isAllowed()) {
			wx.reLaunch({ url: "/pages/consent/index" });
			return;
		}
		const initialized = await app.initializeAfterConsent();
		if (initialized.kind === "UPDATE_REQUIRED") {
			wx.reLaunch({
				url: `/pages/update/index?minimumVersion=${encodeURIComponent(initialized.minimumVersion)}`,
			});
			return;
		}
		this.onShow();
	},

	onShow() {
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		const state = app.featureConfig.current();
		const config = state.kind === "READY" ? state.config : null;
		const theme = app.preferences.theme();
		if (config?.dataRightsMode === "LICENSED_ENRICHMENT") {
			const vector = app.preferences.preferenceVector();
			const controller = requireDecisionFeature().controller;
			for (const item of WEIGHT_OPTIONS) {
				if (
					controller.state.form.preferenceVector[item.key] !== vector[item.key]
				)
					controller.setPreferenceWeight(item.key, vector[item.key]);
			}
		}
		this.setData({
			aiEnabled: app.preferences.aiAssistanceEnabled(),
			preferenceEditable: config?.dataRightsMode === "LICENSED_ENRICHMENT",
			preferenceStored: app.preferences.hasPreferenceVector(),
			weights: WEIGHT_OPTIONS.map((item) => ({
				...item,
				value:
					requireDecisionFeature().controller.state.form.preferenceVector[
						item.key
					],
			})),
			aiServiceAvailable: config?.aiEnabled === true,
			supportFeedbackEnabled: config?.supportFeedbackEnabled === true,
			savedResourcesEnabled:
				config !== null &&
				Object.values(config.persistenceCapabilities).some(Boolean),
			themeIndex: Math.max(
				0,
				THEME_OPTIONS.findIndex((item) => item.value === theme),
			),
			history: app.preferences.decisionHistory().map((entry) => ({
				time: entry.recordedAt.slice(5, 16).replace("T", " "),
				meal: mealLabel(entry.mealPeriod),
				summary: `${entry.decisionMode === "QUICK" ? "快速决定" : "详细偏好"} · ${entry.budgetMaxYuan === null ? "预算不限" : `¥${entry.budgetMaxYuan}/人`} · ${entry.availableMinutes} 分钟`,
				resultCount: entry.resultCount,
			})),
			versionMessage:
				config === null
					? "远程版本要求尚未确认，网络功能保持安全关闭"
					: `当前 0.1.0 · 服务最低要求 ${config.minimumSupportedVersions?.miniprogram ?? "0.1.0"}`,
		});
	},

	onAiChange(event: SwitchEvent) {
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		const enabled = event.detail.value && this.data.aiServiceAvailable;
		app.preferences.setAiAssistanceEnabled(enabled);
		this.setData({ aiEnabled: enabled });
	},

	onTheme(event: WxInputEvent) {
		const index = Number(event.detail.value);
		const theme = THEME_OPTIONS[index]?.value ?? "SYSTEM";
		getApp<ChiShenMeMiniProgramApp>().globalData.preferences.setTheme(theme);
		this.setData({ themeIndex: index });
		applyPageTheme(this);
	},

	onAccount() {
		wx.navigateTo({ url: "/pages/account/index" });
	},

	onSaved() {
		wx.navigateTo({ url: "/pages/saved/index" });
	},

	onFeedback() {
		if (!this.data.supportFeedbackEnabled) return;
		wx.navigateTo({ url: "/pages/feedback/index" });
	},

	onClearHistory() {
		getApp<ChiShenMeMiniProgramApp>().globalData.preferences.clearDecisionHistory();
		this.setData({ history: [] });
	},

	onDocument(event: WxTapEvent) {
		const document = event.currentTarget.dataset.document;
		if (
			document === "PRIVACY" ||
			document === "SOURCES" ||
			document === "ALGORITHM" ||
			document === "SERVICES" ||
			document === "HELP" ||
			document === "VERSION"
		) {
			this.setData({ document });
		}
	},

	onCloseDocument() {
		this.setData({ document: "" });
	},

	onWeight(event: {
		detail: { value: number };
		currentTarget: { dataset: { key?: string } };
	}) {
		const config =
			getApp<ChiShenMeMiniProgramApp>().globalData.featureConfig.current();
		if (
			config.kind !== "READY" ||
			config.config.dataRightsMode !== "LICENSED_ENRICHMENT"
		)
			return;
		const option = WEIGHT_OPTIONS.find(
			(item) => item.key === event.currentTarget.dataset.key,
		);
		if (option === undefined) return;
		requireDecisionFeature().controller.setPreferenceWeight(
			option.key,
			Number(event.detail.value),
		);
		try {
			getApp<ChiShenMeMiniProgramApp>().globalData.preferences.setPreferenceVector(
				requireDecisionFeature().controller.state.form.preferenceVector,
			);
		} catch {
			wx.showToast({ title: "偏好暂未保存，请重试", icon: "none" });
		}
		this.onShow();
	},

	onResetWeights() {
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		const config = app.featureConfig.current();
		if (
			config.kind !== "READY" ||
			config.config.dataRightsMode !== "LICENSED_ENRICHMENT"
		)
			return;
		try {
			app.preferences.setPreferenceVector({
				quality: 100,
				time: 100,
				budget: 100,
				mealMatch: 100,
				diversity: 100,
			});
		} catch {
			wx.showToast({ title: "偏好暂未保存，请重试", icon: "none" });
		}
		this.onShow();
	},

	onClearWeights() {
		try {
			getApp<ChiShenMeMiniProgramApp>().globalData.preferences.clearPreferenceVector();
		} catch {
			wx.showToast({ title: "暂时无法清除，请重试", icon: "none" });
		}
		this.onShow();
	},

	noop() {},

	onWithdrawPrivacy() {
		wx.showModal({
			title: "撤回隐私同意？",
			content:
				"撤回后立即关闭网络能力、清除本机会话与最近决策，并回到首次说明页；外观偏好会保留。",
			confirmText: "确认撤回",
			confirmColor: "#a43d3d",
			success: (result) => {
				if (!result.confirm) return;
				const ok =
					getApp<ChiShenMeMiniProgramApp>().globalData.withdrawPrivacy();
				if (!ok) {
					wx.showToast({
						title: "已在本次运行中关闭；持久化待重试",
						icon: "none",
					});
				}
				wx.reLaunch({ url: "/pages/consent/index" });
			},
		});
	},
});

function mealLabel(value: "BREAKFAST" | "LUNCH" | "DINNER"): string {
	if (value === "BREAKFAST") return "早餐";
	if (value === "DINNER") return "晚餐";
	return "午餐";
}
