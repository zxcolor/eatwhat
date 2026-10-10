import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import {
	type AuthFlowResult,
	normalizeEmail,
	normalizeMainlandPhone,
} from "../../core/auth-session";
import type { PhonePurpose } from "../../core/contracts";

type LoginMethod = "PHONE" | "EMAIL";

interface LoginPageData {
	readonly busy: boolean;
	readonly method: LoginMethod;
	readonly phonePurpose: PhonePurpose;
	readonly statusTone: "neutral" | "success" | "warning" | "error";
	readonly statusMessage: string;
	readonly challengeSent: boolean;
	readonly maskedTarget: string;
	readonly remoteReady: boolean;
	readonly phoneEnabled: boolean;
	readonly emailEnabled: boolean;
	readonly registrationEnabled: boolean;
}

function failureMessage(result: AuthFlowResult): string {
	if (result.kind === "IDENTITY_NOT_BOUND") {
		return "该邮箱尚未绑定手机号主账号，邮箱不能自动注册或找回账号。";
	}
	if (result.kind === "FEATURE_DISABLED") return "该登录方式当前未开放。";
	if (result.kind === "SYNC_FAILED")
		return "登录成功，但账号状态暂未同步，请稍后重试。";
	if (result.kind === "ERROR") {
		return result.retryable
			? "验证未完成，请核对验证码或稍后重试。"
			: "当前账号能力不可用。";
	}
	return "登录未完成。";
}

themedPage({
	operationGeneration: 0,
	pageWasHidden: false,
	onShow() {
		this.setData({ pageActive: true });
		if (this.pageWasHidden) {
			this.pageWasHidden = false;
			void this.onLoad();
		}
	},
	onHide() {
		this.clearSensitivePage();
	},
	onUnload() {
		this.clearSensitivePage();
	},
	clearSensitivePage() {
		this.operationGeneration += 1;
		this.pageWasHidden = true;
		this.phoneInput = "";
		this.emailInput = "";
		this.otpInput = "";
		this.challengeId = null;
		this.challengeScope = null;
		this.setData({
			pageActive: false,
			busy: false,
			challengeSent: false,
			maskedTarget: "",
			remoteReady: false,
		});
	},
	data: {
		busy: true,
		method: "PHONE",
		phonePurpose: "LOGIN",
		statusTone: "neutral",
		statusMessage: "正在检查本机会话…",
		challengeSent: false,
		maskedTarget: "",
		remoteReady: false,
		phoneEnabled: false,
		emailEnabled: false,
		registrationEnabled: false,
	} as LoginPageData,

	phoneInput: "",
	emailInput: "",
	otpInput: "",
	challengeId: null as string | null,
	challengeScope: null as string | null,

	currentChallengeScope() {
		const target =
			this.data.method === "PHONE"
				? normalizeMainlandPhone(this.phoneInput)
				: normalizeEmail(this.emailInput);
		return target === null
			? null
			: `${this.data.method}:${this.data.method === "PHONE" ? this.data.phonePurpose : "LOGIN"}:${target}`;
	},

	clearChallenge() {
		this.operationGeneration += 1;
		this.challengeId = null;
		this.challengeScope = null;
		this.otpInput = "";
		this.setData({ challengeSent: false, maskedTarget: "" });
	},

	onGuest() {
		this.phoneInput = "";
		this.emailInput = "";
		this.otpInput = "";
		this.challengeId = null;
		wx.reLaunch({ url: "/pages/home/index" });
	},

	async onLoad() {
		const operation = this.operationGeneration;
		wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		if (!app.consent.isAllowed()) {
			wx.reLaunch({ url: "/pages/consent/index" });
			return;
		}
		const initialized = await app.initializeAfterConsent();
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
		if (initialized.kind === "UPDATE_REQUIRED") {
			wx.reLaunch({
				url: `/pages/update/index?minimumVersion=${encodeURIComponent(initialized.minimumVersion)}`,
			});
			return;
		}
		const capabilities =
			initialized.kind === "READY" ? initialized.config.authCapabilities : null;
		if (capabilities?.accountsEnabled !== true) {
			this.setData({
				busy: false,
				statusTone: "warning",
				statusMessage: "远程账号能力尚未确认，登录与验证码保持关闭。",
			});
			return;
		}
		const method = capabilities.phoneEnabled ? "PHONE" : "EMAIL";
		this.setData({
			remoteReady: capabilities.phoneEnabled || capabilities.emailEnabled,
			phoneEnabled: capabilities.phoneEnabled,
			emailEnabled: capabilities.emailEnabled,
			registrationEnabled: capabilities.registrationEnabled,
			method,
		});
		await this.restore();
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
	},

	async restore() {
		const operation = this.operationGeneration;
		const result =
			await getApp<ChiShenMeMiniProgramApp>().globalData.auth.restore();
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
		if (result.kind === "SIGNED_IN") {
			wx.reLaunch({ url: "/pages/account/index" });
			return;
		}
		this.setData({
			busy: false,
			statusTone: result.kind === "ERROR" ? "warning" : "neutral",
			statusMessage:
				result.kind === "ERROR"
					? "暂时无法恢复旧会话，你仍可使用验证码重新登录。"
					: "请选择手机号或邮箱登录。",
		});
	},

	onMethodChange(event: WxTapEvent) {
		if (this.data.busy) return;
		const method = event.currentTarget.dataset.method;
		if (method !== "PHONE" && method !== "EMAIL") return;
		if (
			(method === "PHONE" && !this.data.phoneEnabled) ||
			(method === "EMAIL" && !this.data.emailEnabled)
		)
			return;
		this.clearChallenge();
		this.setData({
			method,
			challengeSent: false,
			maskedTarget: "",
			statusTone: "neutral",
			statusMessage:
				method === "PHONE"
					? "手机号可注册或登录。"
					: "邮箱只能登录已经绑定的账号。",
		});
	},

	onPurposeChange(event: WxTapEvent) {
		if (this.data.busy) return;
		const purpose = event.currentTarget.dataset.purpose;
		if (purpose !== "REGISTER" && purpose !== "LOGIN") return;
		if (purpose === "REGISTER" && !this.data.registrationEnabled) return;
		this.clearChallenge();
		this.setData({
			phonePurpose: purpose,
			challengeSent: false,
			maskedTarget: "",
			statusTone: "neutral",
			statusMessage:
				purpose === "REGISTER"
					? "验证手机号后创建主账号。"
					: "登录已有手机号主账号。",
		});
	},

	onPhoneInput(event: WxInputEvent) {
		if (this.data.busy) return;
		if (this.phoneInput !== event.detail.value) this.clearChallenge();
		this.phoneInput = event.detail.value;
	},

	onEmailInput(event: WxInputEvent) {
		if (this.data.busy) return;
		if (this.emailInput !== event.detail.value) this.clearChallenge();
		this.emailInput = event.detail.value;
	},

	onOtpInput(event: WxInputEvent) {
		if (this.data.busy) return;
		this.otpInput = event.detail.value.trim();
	},

	async onRequestCode() {
		const operation = this.operationGeneration;
		if (
			this.data.busy ||
			!this.data.remoteReady ||
			(this.data.method === "PHONE" && !this.data.phoneEnabled) ||
			(this.data.method === "EMAIL" && !this.data.emailEnabled) ||
			(this.data.method === "PHONE" &&
				this.data.phonePurpose === "REGISTER" &&
				!this.data.registrationEnabled)
		)
			return;
		const scope = this.currentChallengeScope();
		if (scope === null) {
			this.setData({
				statusTone: "error",
				statusMessage: "请先填写有效手机号或邮箱。",
			});
			return;
		}
		this.challengeId = null;
		this.challengeScope = null;
		this.otpInput = "";
		this.setData({
			busy: true,
			challengeSent: false,
			maskedTarget: "",
			statusTone: "neutral",
			statusMessage: "正在请求验证码…",
		});
		try {
			const auth = getApp<ChiShenMeMiniProgramApp>().globalData.auth;
			const challenge =
				this.data.method === "PHONE"
					? await (() => {
							const phone = normalizeMainlandPhone(this.phoneInput);
							if (phone === null) throw new Error("PHONE_INVALID");
							return auth.requestPhoneChallenge(phone, this.data.phonePurpose);
						})()
					: await (() => {
							const email = normalizeEmail(this.emailInput);
							if (email === null) throw new Error("EMAIL_INVALID");
							return auth.requestEmailChallenge(email, "LOGIN");
						})();
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.challengeId = challenge.challengeId;
			this.challengeScope = scope;
			this.setData({
				busy: false,
				challengeSent: true,
				maskedTarget: challenge.maskedTarget,
				statusTone: "success",
				statusMessage: `验证码已发送至 ${challenge.maskedTarget}`,
			});
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.challengeId = null;
			this.challengeScope = null;
			this.setData({
				busy: false,
				challengeSent: false,
				maskedTarget: "",
				statusTone: "error",
				statusMessage: "验证码请求失败，请检查输入或稍后重试。",
			});
		}
	},

	async onSubmit() {
		const operation = this.operationGeneration;
		if (this.data.busy || !this.data.remoteReady || this.challengeId === null)
			return;
		if (
			this.challengeScope === null ||
			this.challengeScope !== this.currentChallengeScope()
		) {
			this.clearChallenge();
			this.setData({
				statusTone: "warning",
				statusMessage: "登录信息已变更，请重新获取验证码。",
			});
			return;
		}
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在安全验证…",
		});
		const auth = getApp<ChiShenMeMiniProgramApp>().globalData.auth;
		let result: AuthFlowResult;
		if (this.data.method === "PHONE") {
			const phone = normalizeMainlandPhone(this.phoneInput);
			result =
				phone === null
					? { kind: "ERROR", retryable: true }
					: await auth.loginWithPhone(
							phone,
							this.challengeId,
							this.otpInput,
							this.data.phonePurpose,
						);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
		} else {
			result = await auth.loginWithEmail(this.challengeId, this.otpInput);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
		}
		if (result.kind === "SIGNED_IN") {
			wx.reLaunch({ url: "/pages/account/index" });
			return;
		}
		this.setData({
			busy: false,
			statusTone: result.kind === "IDENTITY_NOT_BOUND" ? "warning" : "error",
			statusMessage: failureMessage(result),
		});
	},
});
