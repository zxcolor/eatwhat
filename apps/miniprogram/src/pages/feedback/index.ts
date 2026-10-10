import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import type { SupportFeedbackCategory } from "../../features/support/support-feedback";

const OPTIONS: readonly Readonly<{
	value: SupportFeedbackCategory;
	label: string;
}>[] = [
	{ value: "PRODUCT", label: "产品建议" },
	{ value: "PLACE_CORRECTION", label: "餐厅纠错" },
	{ value: "PRIVACY", label: "隐私问题" },
	{ value: "COMPLAINT", label: "投诉" },
];

themedPage({
	data: {
		categories: OPTIONS.map((item, index) => ({ ...item, index })),
		categoryIndex: 0,
		message: "",
		messageLength: 0,
		busy: false,
		enabled: false,
		statusMessage: "",
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
		const enabled =
			initialized.kind === "READY" && initialized.config.supportFeedbackEnabled;
		this.setData({
			enabled,
			statusMessage: enabled
				? ""
				: "反馈服务尚未完成就绪确认，当前不会提交内容。",
		});
	},

	onCategory(event: WxInputEvent) {
		this.setData({ categoryIndex: Number(event.detail.value) });
	},

	onMessage(event: WxInputEvent) {
		const message = String(event.detail.value ?? "");
		this.setData({
			message,
			messageLength: [...message].length,
			statusMessage: "",
		});
	},

	async onSubmit() {
		if (this.data.busy || !this.data.enabled) return;
		const category = OPTIONS[this.data.categoryIndex]?.value ?? "PRODUCT";
		this.setData({ busy: true, statusMessage: "" });
		const outcome =
			await getApp<ChiShenMeMiniProgramApp>().globalData.support.submit(
				category,
				this.data.message,
			);
		if (outcome.ok) {
			this.setData({
				busy: false,
				message: "",
				messageLength: 0,
				statusMessage: "反馈已受理。关闭后相关内容再保留 180 天。",
			});
			return;
		}
		this.setData({ busy: false, statusMessage: outcome.message });
	},
});
