import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";

themedPage({
	data: {
		document: "" as "" | "PRIVACY" | "TERMS" | "SERVICES" | "AI",
		errorMessage: "",
	},

	onLoad() {
		wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
		if (getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()) {
			wx.reLaunch({ url: "/pages/home/index" });
		}
	},

	onDocument(event: WxTapEvent) {
		const value = event.currentTarget.dataset.document;
		if (
			value === "PRIVACY" ||
			value === "TERMS" ||
			value === "SERVICES" ||
			value === "AI"
		) {
			this.setData({ document: value });
		}
	},

	onCloseDocument() {
		this.setData({ document: "" });
	},

	noop() {},

	onAccept() {
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		if (!app.acceptPrivacy()) {
			this.setData({
				errorMessage: "本机暂时无法安全保存你的选择，请稍后重试。",
			});
			return;
		}
		wx.reLaunch({ url: "/pages/home/index" });
	},

	onDecline() {
		wx.showModal({
			title: "你仍然拥有选择权",
			content:
				"未同意时不会启动推荐、账号或反馈网络请求。你可以继续阅读说明，稍后再决定；拒绝系统定位权限不影响手动选址。",
			showCancel: false,
			success() {},
		});
	},
});
