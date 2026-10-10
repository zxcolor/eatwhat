import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import type {
	AccountSnapshot,
	BindingSummary,
	SessionDisplay,
} from "../../core/auth-session";
import { normalizeEmail } from "../../core/auth-session";
import type { AccountExportStatus } from "../../core/contracts";

interface AccountPageData {
	readonly busy: boolean;
	readonly statusTone: "neutral" | "success" | "warning" | "error";
	readonly statusMessage: string;
	readonly bindings: readonly BindingSummary[];
	readonly sessions: readonly SessionDisplay[];
	readonly hasEmailBinding: boolean;
	readonly emailChallengeSent: boolean;
	readonly emailMaskedTarget: string;
	readonly includeBehaviorHistory: boolean;
	readonly exportStatusLabel: string;
	readonly exportReady: boolean;
	readonly exportFileReady: boolean;
	readonly deleteConfirmationReady: boolean;
	readonly emailEnabled: boolean;
	readonly dataExportEnabled: boolean;
	readonly remoteReady: boolean;
}

function exportLabel(status: AccountExportStatus | null): string {
	if (status === null) return "尚未申请数据导出";
	if (status.status === "QUEUED") return "导出任务已排队";
	if (status.status === "PROCESSING") return "正在生成导出文件";
	if (status.status === "READY")
		return `导出已就绪（${status.sizeBytes} 字节）`;
	if (status.status === "FAILED") return "导出生成失败，可重新申请";
	return "导出文件已过期，可重新申请";
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
		if (!this.exportHandoffInFlight) this.clearVerifiedExport();
		this.emailInput = "";
		this.emailOtpInput = "";
		this.emailChallengeId = null;
		this.currentExport = null;
		this.deleteConfirmation = "";
		this.setData({
			pageActive: false,
			busy: false,
			remoteReady: false,
			emailChallengeSent: false,
			emailMaskedTarget: "",
			deleteConfirmationReady: false,
			bindings: [],
			sessions: [],
			exportReady: false,
		});
	},
	data: {
		busy: true,
		statusTone: "neutral",
		statusMessage: "正在同步账号状态…",
		bindings: [],
		sessions: [],
		hasEmailBinding: false,
		emailChallengeSent: false,
		emailMaskedTarget: "",
		includeBehaviorHistory: true,
		exportStatusLabel: "正在读取导出状态…",
		exportReady: false,
		exportFileReady: false,
		deleteConfirmationReady: false,
		emailEnabled: false,
		dataExportEnabled: false,
		remoteReady: false,
	} as AccountPageData,

	emailInput: "",
	emailOtpInput: "",
	emailChallengeId: null as string | null,
	currentExport: null as AccountExportStatus | null,
	verifiedExportPath: null as string | null,
	exportHandoffInFlight: false,
	deleteConfirmation: "",

	clearVerifiedExport() {
		const path = this.verifiedExportPath;
		this.verifiedExportPath = null;
		if (path !== null) removeExportFile(path);
		this.setData({ exportFileReady: false });
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
		if (
			initialized.kind !== "READY" ||
			!initialized.config.authCapabilities.accountsEnabled
		) {
			this.setData({
				busy: false,
				statusTone: "warning",
				statusMessage: "远程账号能力尚未确认，本页不会读取或修改账号数据。",
			});
			return;
		}
		this.setData({
			busy: false,
			remoteReady: true,
			emailEnabled: initialized.config.authCapabilities.emailEnabled,
			dataExportEnabled: initialized.config.authCapabilities.dataExportEnabled,
		});
		await this.loadAccount();
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
	},

	async loadAccount() {
		const operation = this.operationGeneration;
		if (!this.data.remoteReady || this.data.busy) return;
		this.setData({ busy: true });
		const auth = getApp<ChiShenMeMiniProgramApp>().globalData.auth;
		const result = await auth.syncAccount();
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
		if (result.kind === "SIGNED_OUT") {
			wx.reLaunch({ url: "/pages/login/index" });
			return;
		}
		if (result.kind !== "SIGNED_IN") {
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "账号状态同步失败，请检查网络后重试。",
			});
			return;
		}
		this.applyAccount(result.account);
		if (!this.data.dataExportEnabled) {
			this.setData({
				exportStatusLabel: "数据导出当前未开放",
				exportReady: false,
			});
			return;
		}
		try {
			const latest = await auth.getLatestAccountExport();
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.applyExport(latest);
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.setData({
				exportStatusLabel: "数据导出状态暂不可用",
				exportReady: false,
			});
		}
	},

	applyAccount(account: AccountSnapshot) {
		this.setData({
			busy: false,
			statusTone: "success",
			statusMessage: account.hasPhoneBinding
				? "账号主身份与设备会话已同步。"
				: "当前摘要未确认手机号主身份，请停止敏感操作并刷新。",
			bindings: account.bindings,
			sessions: account.sessions,
			hasEmailBinding: account.hasEmailBinding,
		});
	},

	applyExport(status: AccountExportStatus | null) {
		this.currentExport = status;
		this.setData({
			exportStatusLabel: exportLabel(status),
			exportReady: status?.status === "READY",
		});
	},

	onEmailInput(event: WxInputEvent) {
		if (this.data.busy) return;
		if (event.detail.value !== this.emailInput) {
			this.operationGeneration += 1;
			this.emailChallengeId = null;
			this.emailOtpInput = "";
			this.setData({ emailChallengeSent: false, emailMaskedTarget: "" });
		}
		this.emailInput = event.detail.value;
	},

	onEmailOtpInput(event: WxInputEvent) {
		if (this.data.busy) return;
		this.emailOtpInput = event.detail.value.trim();
	},

	async onRequestEmailBindCode() {
		const operation = this.operationGeneration;
		if (
			this.data.busy ||
			!this.data.remoteReady ||
			!this.data.emailEnabled ||
			this.data.hasEmailBinding
		)
			return;
		const email = normalizeEmail(this.emailInput);
		if (email === null) {
			this.setData({
				statusTone: "error",
				statusMessage: "请输入有效邮箱地址。",
			});
			return;
		}
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在请求邮箱验证码…",
		});
		try {
			const challenge =
				await getApp<ChiShenMeMiniProgramApp>().globalData.auth.requestEmailChallenge(
					email,
					"BIND",
				);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.emailChallengeId = challenge.challengeId;
			this.setData({
				busy: false,
				emailChallengeSent: true,
				emailMaskedTarget: challenge.maskedTarget,
				statusTone: "success",
				statusMessage: `验证码已发送至 ${challenge.maskedTarget}`,
			});
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.emailChallengeId = null;
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "邮箱验证码请求失败。",
			});
		}
	},

	async onBindEmail() {
		const operation = this.operationGeneration;
		if (
			this.data.busy ||
			!this.data.remoteReady ||
			this.emailChallengeId === null
		)
			return;
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在绑定邮箱…",
		});
		try {
			const account =
				await getApp<ChiShenMeMiniProgramApp>().globalData.auth.bindEmail(
					this.emailChallengeId,
					this.emailOtpInput,
				);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.emailChallengeId = null;
			this.emailOtpInput = "";
			this.applyAccount(account);
			this.setData({ emailChallengeSent: false, emailMaskedTarget: "" });
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "邮箱绑定失败，请核对验证码。",
			});
		}
	},

	async onRevokeSession(event: WxTapEvent) {
		const operation = this.operationGeneration;
		const sessionId = event.currentTarget.dataset.sessionId;
		if (
			typeof sessionId !== "string" ||
			this.data.busy ||
			!this.data.remoteReady
		)
			return;
		const confirmed = await new Promise<boolean>((resolve) => {
			wx.showModal({
				title: "撤销登录设备",
				content: "该设备上的登录会话将立即失效。",
				confirmText: "确认撤销",
				confirmColor: "#ba1a1a",
				success: (result) => resolve(result.confirm),
				fail: () => resolve(false),
			});
		});
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
		if (!confirmed) return;
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在撤销设备会话…",
		});
		try {
			const account =
				await getApp<ChiShenMeMiniProgramApp>().globalData.auth.revokeSession(
					sessionId,
				);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.applyAccount(account);
			this.setData({ statusMessage: "设备会话已撤销。" });
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "设备会话撤销失败。",
			});
		}
	},

	onIncludeHistoryChange(event: WxSwitchEvent) {
		this.setData({ includeBehaviorHistory: event.detail.value });
	},

	async onRequestExport() {
		const operation = this.operationGeneration;
		if (
			this.data.busy ||
			!this.data.remoteReady ||
			!this.data.dataExportEnabled
		)
			return;
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在申请数据导出…",
		});
		try {
			const receipt =
				await getApp<ChiShenMeMiniProgramApp>().globalData.auth.requestAccountExport(
					this.data.includeBehaviorHistory,
				);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			const status =
				await getApp<ChiShenMeMiniProgramApp>().globalData.auth.getAccountExport(
					receipt.exportId,
				);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.applyExport(status);
			this.setData({
				busy: false,
				statusTone: "success",
				statusMessage: "导出任务已创建。",
			});
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "数据导出申请失败。",
			});
		}
	},

	async onRefreshExport() {
		const operation = this.operationGeneration;
		if (
			this.data.busy ||
			!this.data.remoteReady ||
			!this.data.dataExportEnabled
		)
			return;
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在刷新导出状态…",
		});
		try {
			const auth = getApp<ChiShenMeMiniProgramApp>().globalData.auth;
			const status =
				this.currentExport === null
					? await auth.getLatestAccountExport()
					: await auth.getAccountExport(this.currentExport.exportId);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.applyExport(status);
			this.setData({
				busy: false,
				statusTone: "success",
				statusMessage: "导出状态已刷新。",
			});
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "导出状态刷新失败。",
			});
		}
	},

	async onDownloadExport() {
		const operation = this.operationGeneration;
		if (
			this.data.busy ||
			this.exportHandoffInFlight ||
			!this.data.remoteReady ||
			!this.data.dataExportEnabled ||
			this.currentExport?.status !== "READY"
		)
			return;
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在下载并校验导出文件…",
		});
		try {
			const app = getApp<ChiShenMeMiniProgramApp>();
			const verified = await app.globalData.auth.downloadAccountExport(
				this.currentExport,
				app.globalData.exportDownloader,
			);
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			) {
				removeExportFile(verified.savedFilePath);
				return;
			}
			this.clearVerifiedExport();
			this.verifiedExportPath = verified.savedFilePath;
			this.setData({
				busy: false,
				exportFileReady: true,
				statusTone: "success",
				statusMessage:
					"文件已下载并通过完整性校验，请点“取出导出文件”自行选择保存去向。离开本页会清除本次文件。",
			});
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "下载或完整性校验失败，未将本次结果视为成功。",
			});
		}
	},

	async onTakeExport() {
		const operation = this.operationGeneration;
		const filePath = this.verifiedExportPath;
		if (
			this.data.busy ||
			filePath === null ||
			!this.data.remoteReady ||
			!this.data.dataExportEnabled
		)
			return;
		const runtime = wx as unknown as {
			shareFileMessage?: (options: {
				filePath: string;
				fileName: string;
				success(): void;
				fail(): void;
				complete(): void;
			}) => void;
		};
		if (runtime.shareFileMessage === undefined) {
			this.setData({
				statusTone: "warning",
				statusMessage:
					"当前微信版本不支持取出此文件，请升级微信后重新下载。文件尚未交付。",
			});
			return;
		}
		const confirmed = await new Promise<boolean>((resolve) =>
			wx.showModal({
				title: "取出个人账号数据",
				content:
					"文件包含你的账号数据。接下来由你选择接收者或保存去向，请谨慎保管。",
				confirmText: "选择去向",
				success: (result) => resolve(result.confirm),
				fail: () => resolve(false),
			}),
		);
		if (
			!confirmed ||
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
		this.setData({ busy: true });
		this.exportHandoffInFlight = true;
		const cleanup = () => {
			this.exportHandoffInFlight = false;
			const path = this.verifiedExportPath;
			this.verifiedExportPath = null;
			if (path !== null) removeExportFile(path);
			if (operation === this.operationGeneration)
				this.setData({ exportFileReady: false });
		};
		try {
			runtime.shareFileMessage({
				filePath,
				fileName: "吃什么-我的数据.json",
				success: () => {
					cleanup();
					if (operation !== this.operationGeneration) return;
					this.setData({
						busy: false,
						statusTone: "success",
						statusMessage: "微信已确认文件取出操作完成，请在你选择的去向核对。",
					});
				},
				fail: () => {
					cleanup();
					if (operation !== this.operationGeneration) return;
					this.setData({
						busy: false,
						statusTone: "warning",
						statusMessage:
							"文件取出已取消或未完成，尚未确认交付。本次文件已清除，可重新下载。",
					});
				},
				complete: cleanup,
			});
		} catch {
			cleanup();
			if (operation === this.operationGeneration)
				this.setData({
					busy: false,
					statusTone: "warning",
					statusMessage: "当前无法取出文件，本次文件已清除。",
				});
		}
	},

	onDeleteConfirmationInput(event: WxInputEvent) {
		this.deleteConfirmation = event.detail.value.trim();
		this.setData({
			deleteConfirmationReady: this.deleteConfirmation === "注销账号",
		});
	},

	async onDeleteAccount() {
		const operation = this.operationGeneration;
		if (
			this.data.busy ||
			!this.data.remoteReady ||
			this.deleteConfirmation !== "注销账号"
		)
			return;
		const confirmed = await new Promise<boolean>((resolve) => {
			wx.showModal({
				title: "永久注销账号",
				content: "账号会立即停用，所有会话失效。该操作不能在小程序内撤销。",
				confirmText: "确认注销",
				confirmColor: "#ba1a1a",
				success: (result) => resolve(result.confirm),
				fail: () => resolve(false),
			});
		});
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
		if (!confirmed) return;
		this.setData({
			busy: true,
			statusTone: "warning",
			statusMessage: "正在注销账号…",
		});
		try {
			await getApp<ChiShenMeMiniProgramApp>().globalData.auth.deleteAccount();
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			wx.showToast({ title: "账号已注销", icon: "success" });
			wx.reLaunch({ url: "/pages/login/index" });
		} catch {
			if (
				operation !== this.operationGeneration ||
				!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
			)
				return;
			this.setData({
				busy: false,
				statusTone: "error",
				statusMessage: "账号注销失败，本次未视为成功。",
			});
		}
	},

	async onLogout() {
		const operation = this.operationGeneration;
		if (this.data.busy) return;
		this.setData({
			busy: true,
			statusTone: "neutral",
			statusMessage: "正在退出…",
		});
		const auth = getApp<ChiShenMeMiniProgramApp>().globalData.auth;
		if (!this.data.remoteReady) {
			auth.invalidate();
			wx.showToast({ title: "本机已退出", icon: "success" });
			wx.reLaunch({ url: "/pages/login/index" });
			return;
		}
		const result = await auth.logout();
		if (
			operation !== this.operationGeneration ||
			!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()
		)
			return;
		wx.showToast({
			title: result.remoteConfirmed ? "已退出" : "本机已退出",
			icon: "success",
		});
		wx.reLaunch({ url: "/pages/login/index" });
	},
});

function removeExportFile(path: string): void {
	try {
		wx.getFileSystemManager().unlinkSync(path);
	} catch {
		/* Never log a private local file path. */
	}
}
