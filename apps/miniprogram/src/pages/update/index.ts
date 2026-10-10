import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
themedPage({
	data: { minimumVersion: "", checking: false, message: "" },

	onLoad(query: Record<string, string | undefined>) {
		wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
		this.setData({
			minimumVersion: /^\d+\.\d+\.\d+$/.test(query.minimumVersion ?? "")
				? query.minimumVersion
				: "最新版本",
		});
	},

	async onRetry() {
		if (this.data.checking) return;
		this.setData({ checking: true, message: "" });
		const result =
			await getApp<ChiShenMeMiniProgramApp>().globalData.initializeAfterConsent();
		this.setData({ checking: false });
		if (result.kind === "READY") wx.reLaunch({ url: "/pages/home/index" });
		else if (result.kind === "PRIVACY_REQUIRED")
			wx.reLaunch({ url: "/pages/consent/index" });
		else
			this.setData({
				message:
					result.kind === "UPDATE_REQUIRED"
						? "仍需更新小程序，请关闭后重新进入再试。"
						: "暂时无法确认版本，请稍后重新检查。",
				...(result.kind === "UPDATE_REQUIRED"
					? { minimumVersion: result.minimumVersion }
					: {}),
			});
	},

	onLocalLogout() {
		getApp<ChiShenMeMiniProgramApp>().globalData.auth.invalidate();
		this.setData({ message: "本机已退出。其他设备的会话保持原状。" });
	},

	onWithdrawPrivacy() {
		wx.showModal({
			title: "撤回隐私同意？",
			content: "本机登录状态与最近决策将被清除。",
			confirmText: "确认撤回",
			success: (result) => {
				if (!result.confirm) return;
				getApp<ChiShenMeMiniProgramApp>().globalData.withdrawPrivacy();
				wx.reLaunch({ url: "/pages/consent/index" });
			},
		});
	},
});
