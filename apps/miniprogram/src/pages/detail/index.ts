import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import { requireDecisionFeature } from "../../features/decision/index";
import type {
	FavoriteGroup,
	PrivateFeedbackType,
} from "../../features/persistence/contracts";
import { projectRestaurantDetail } from "./model";

interface DetailPageRuntime {
	navigateBack(options?: { readonly delta?: number }): void;
	showToast(options: {
		readonly title: string;
		readonly icon: "none" | "success";
	}): void;
	hideShareMenu?(options?: { readonly menus?: string[] }): void;
}

const feature = requireDecisionFeature();
const controller = feature.controller;
const runtime = wx as unknown as DetailPageRuntime;

themedPage({
	data: {
		available: false,
		expiredMessage: "正在读取本次结果…",
		favoriteEnabled: false,
		privateFeedbackEnabled: false,
		persistenceBusy: false,
		persistenceMessage: "",
		feedbackOptions: [
			{ value: "WANT_TO_EAT", label: "想吃" },
			{ value: "ATE", label: "吃过" },
			{ value: "LIKE", label: "喜欢" },
			{ value: "DISLIKE", label: "不喜欢" },
			{ value: "TOO_FAR", label: "太远" },
			{ value: "TOO_EXPENSIVE", label: "太贵" },
			{ value: "RECENTLY_ATE", label: "最近吃过" },
			{ value: "AVOID_CUISINE", label: "避开菜系" },
		],
	},
	unsubscribe: null as (() => void) | null,

	onLoad() {
		runtime.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
		if (!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()) {
			wx.reLaunch({ url: "/pages/consent/index" });
			return;
		}
		this.unsubscribe = controller.subscribe(() => this.render());
	},

	onUnload() {
		this.unsubscribe?.();
		this.unsubscribe = null;
		controller.clearSelectedResult();
	},

	render() {
		const config =
			getApp<ChiShenMeMiniProgramApp>().globalData.featureConfig.current();
		const result = feature.sessions.selected();
		const response = feature.sessions.currentResponse();
		const persistable =
			result !== null &&
			response !== null &&
			result.dataMode === "LIVE" &&
			response.dataRightsMode === "LICENSED_ENRICHMENT";
		this.setData({
			favoriteEnabled:
				persistable &&
				config.kind === "READY" &&
				config.config.persistenceCapabilities.savedResourceIdsEnabled &&
				config.config.persistenceCapabilities.favoritesEnabled,
			privateFeedbackEnabled:
				persistable &&
				config.kind === "READY" &&
				config.config.persistenceCapabilities.savedResourceIdsEnabled &&
				config.config.persistenceCapabilities.privateFeedbackEnabled,
		});
		if (result === null) {
			this.setData({
				available: false,
				expiredMessage: "本次结果已失效，请返回重新获取。",
			});
			return;
		}
		const state = feature.sessions.state(result.resultToken);
		this.setData({
			available: true,
			...projectRestaurantDetail(result, state),
		});
	},

	async onNavigate() {
		const token = feature.sessions.selected()?.resultToken;
		if (token === undefined || !(await feature.actions.navigate(token))) {
			runtime.showToast({ title: "地图操作不可用或结果已失效", icon: "none" });
		}
	},

	async onCall() {
		const token = feature.sessions.selected()?.resultToken;
		if (token === undefined || !(await feature.actions.call(token))) {
			runtime.showToast({ title: "联系电话不可用或结果已失效", icon: "none" });
		}
	},

	async onCopyAddress() {
		const token = feature.sessions.selected()?.resultToken;
		if (token === undefined || !(await feature.actions.copyAddress(token))) {
			runtime.showToast({ title: "地址不可用或结果已失效", icon: "none" });
			return;
		}
		runtime.showToast({ title: "地址已复制", icon: "success" });
	},

	async onFavorite(event: WxTapEvent) {
		const group = event.currentTarget.dataset.group;
		if (
			this.data.persistenceBusy ||
			!this.data.favoriteEnabled ||
			(group !== "WANT_TO_GO" && group !== "REGULAR")
		)
			return;
		const reference = currentReference();
		if (reference === null) return;
		this.setData({ persistenceBusy: true, persistenceMessage: "" });
		const outcome =
			await getApp<ChiShenMeMiniProgramApp>().globalData.saved.createFavorite(
				reference,
				group as FavoriteGroup,
			);
		this.setData({
			persistenceBusy: false,
			persistenceMessage: outcome.ok
				? group === "WANT_TO_GO"
					? "已收藏到“想去”"
					: "已收藏到“常吃”"
				: outcome.message,
		});
	},

	async onPrivateFeedback(event: WxTapEvent) {
		const type = event.currentTarget.dataset.type;
		if (
			this.data.persistenceBusy ||
			!this.data.privateFeedbackEnabled ||
			!isFeedbackType(type)
		) {
			return;
		}
		const reference = currentReference();
		if (reference === null) return;
		this.setData({ persistenceBusy: true, persistenceMessage: "" });
		const outcome =
			await getApp<ChiShenMeMiniProgramApp>().globalData.saved.createPrivateFeedback(
				reference,
				type,
			);
		this.setData({
			persistenceBusy: false,
			persistenceMessage: outcome.ok
				? "私有反馈已记录，不会形成公开评分"
				: outcome.message,
		});
	},

	onBack() {
		runtime.navigateBack({ delta: 1 });
	},
});

function currentReference(): {
	readonly requestId: string;
	readonly resultToken: string;
	readonly dataMode: "LIVE" | "DEMO";
	readonly dataRightsMode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
} | null {
	const response = feature.sessions.currentResponse();
	const selected = feature.sessions.selected();
	if (response === null || selected === null) return null;
	return Object.freeze({
		requestId: response.requestId,
		resultToken: selected.resultToken,
		dataMode: selected.dataMode,
		dataRightsMode: response.dataRightsMode,
	});
}

function isFeedbackType(value: unknown): value is PrivateFeedbackType {
	return (
		value === "WANT_TO_EAT" ||
		value === "ATE" ||
		value === "LIKE" ||
		value === "DISLIKE" ||
		value === "TOO_FAR" ||
		value === "TOO_EXPENSIVE" ||
		value === "RECENTLY_ATE" ||
		value === "AVOID_CUISINE"
	);
}
