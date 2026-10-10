import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import type {
	FavoriteRecord,
	PrivateFeedbackRecord,
	RecommendationHistoryItem,
} from "../../features/persistence/contracts";

type Section = "FAVORITES" | "HISTORY" | "PRIVATE_FEEDBACK";

themedPage({
	data: {
		busy: false,
		loginRequired: false,
		message: "",
		selected: "FAVORITES" as Section,
		sections: [] as readonly Record<string, unknown>[],
		favorites: [] as readonly Record<string, unknown>[],
		history: [] as readonly Record<string, unknown>[],
		feedback: [] as readonly Record<string, unknown>[],
		favoriteRecords: [] as readonly FavoriteRecord[],
		feedbackRecords: [] as readonly PrivateFeedbackRecord[],
		favoritesCursor: null as string | null,
		historyCursor: null as string | null,
		feedbackCursor: null as string | null,
		hasMore: false,
	},

	operationGeneration: 0,
	pageActive: false,

	onLoad() {
		wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
	},

	async onShow() {
		this.clearSensitivePage();
		this.pageActive = true;
		const operation = this.operationGeneration;
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		if (!app.consent.isAllowed()) {
			wx.reLaunch({ url: "/pages/consent/index" });
			return;
		}
		this.setData({ busy: true });
		try {
			const initialized = await app.initializeAfterConsent();
			if (!this.isCurrentOperation(operation)) return;
			this.setData({ busy: false });
			if (initialized.kind === "UPDATE_REQUIRED") {
				wx.reLaunch({
					url: `/pages/update/index?minimumVersion=${encodeURIComponent(initialized.minimumVersion)}`,
				});
				return;
			}
			await this.configureAndLoad();
		} catch {
			this.applyUnexpectedFailure(operation);
		} finally {
			if (this.isCurrentOperation(operation)) this.setData({ busy: false });
		}
	},

	onHide() {
		this.clearSensitivePage();
	},

	onUnload() {
		this.clearSensitivePage();
	},

	clearRecords() {
		this.setData({
			favorites: [],
			history: [],
			feedback: [],
			favoriteRecords: [],
			feedbackRecords: [],
			favoritesCursor: null,
			historyCursor: null,
			feedbackCursor: null,
			hasMore: false,
		});
	},

	clearSensitivePage() {
		this.operationGeneration += 1;
		this.pageActive = false;
		this.clearRecords();
		this.setData({
			sections: [],
			busy: false,
			loginRequired: false,
			message: "",
		});
	},

	isCurrentOperation(operation: number): boolean {
		if (!this.pageActive || operation !== this.operationGeneration)
			return false;
		if (!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()) {
			this.clearSensitivePage();
			return false;
		}
		return true;
	},

	async configureAndLoad() {
		const state =
			getApp<ChiShenMeMiniProgramApp>().globalData.featureConfig.current();
		const caps =
			state.kind === "READY" ? state.config.persistenceCapabilities : null;
		const sections = [
			{
				value: "FAVORITES",
				label: "收藏",
				enabled: caps?.favoritesEnabled === true,
			},
			{
				value: "HISTORY",
				label: "账号历史",
				enabled: caps?.historyEnabled === true,
			},
			{
				value: "PRIVATE_FEEDBACK",
				label: "私有反馈",
				enabled: caps?.privateFeedbackEnabled === true,
			},
		].filter((item) => item.enabled);
		if (sections.length === 0) {
			this.clearRecords();
			this.setData({
				sections: [],
				busy: false,
				message:
					"远程配置、数据授权或账号记录能力尚未开放；本机最近决策不会被上传。",
			});
			return;
		}
		const selected = sections.some((item) => item.value === this.data.selected)
			? this.data.selected
			: (sections[0]?.value as Section);
		this.setData({ sections, selected, message: "" });
		await this.load(false);
	},

	onLogin() {
		wx.navigateTo({ url: "/pages/login/index" });
	},

	onSection(event: WxTapEvent) {
		const value = event.currentTarget.dataset.value;
		if (
			this.data.busy ||
			!this.pageActive ||
			!this.data.sections.some((section) => section.value === value) ||
			(value !== "FAVORITES" &&
				value !== "HISTORY" &&
				value !== "PRIVATE_FEEDBACK")
		)
			return;
		this.setData({ selected: value, message: "", loginRequired: false });
		void this.load(false);
	},

	onRefresh() {
		void this.load(false);
	},

	onLoadMore() {
		if (this.data.hasMore) void this.load(true);
	},

	onToggleGroup(event: WxTapEvent) {
		const index = Number(event.currentTarget.dataset.index);
		const record = this.data.favoriteRecords[index];
		if (record === undefined) return;
		const group = record.group === "WANT_TO_GO" ? "REGULAR" : "WANT_TO_GO";
		void this.mutate(async (isCurrent) => {
			const outcome =
				await getApp<ChiShenMeMiniProgramApp>().globalData.saved.updateFavoriteGroup(
					record.favoriteId,
					group,
				);
			if (!outcome.ok || !isCurrent()) return outcome;
			const records = this.data.favoriteRecords.map((item) =>
				item.favoriteId === outcome.value.favoriteId ? outcome.value : item,
			);
			this.setData({
				favoriteRecords: records,
				favorites: records.map(viewFavorite),
			});
			return outcome;
		}, "收藏分组已更新");
	},

	onDeleteFavorite(event: WxTapEvent) {
		const index = Number(event.currentTarget.dataset.index);
		const record = this.data.favoriteRecords[index];
		if (record === undefined) return;
		this.confirm("删除这条收藏？", () =>
			this.mutate(async (isCurrent) => {
				const outcome =
					await getApp<ChiShenMeMiniProgramApp>().globalData.saved.deleteFavorite(
						record.favoriteId,
					);
				if (outcome.ok && isCurrent()) {
					const records = this.data.favoriteRecords.filter(
						(item) => item.favoriteId !== record.favoriteId,
					);
					this.setData({
						favoriteRecords: records,
						favorites: records.map(viewFavorite),
					});
				}
				return outcome;
			}, "收藏已删除"),
		);
	},

	onDeleteFeedback(event: WxTapEvent) {
		const index = Number(event.currentTarget.dataset.index);
		const record = this.data.feedbackRecords[index];
		if (record === undefined) return;
		this.confirm("删除这条私有反馈？", () =>
			this.mutate(async (isCurrent) => {
				const outcome =
					await getApp<ChiShenMeMiniProgramApp>().globalData.saved.deletePrivateFeedback(
						record.feedbackId,
					);
				if (outcome.ok && isCurrent()) {
					const records = this.data.feedbackRecords.filter(
						(item) => item.feedbackId !== record.feedbackId,
					);
					this.setData({
						feedbackRecords: records,
						feedback: records.map(viewFeedback),
					});
				}
				return outcome;
			}, "私有反馈已删除"),
		);
	},

	onClearCurrent() {
		if (this.data.selected === "FAVORITES") return;
		const history = this.data.selected === "HISTORY";
		this.confirm(history ? "清空全部账号历史？" : "清空全部私有反馈？", () =>
			this.mutate(
				async (isCurrent) => {
					const saved = getApp<ChiShenMeMiniProgramApp>().globalData.saved;
					const outcome = history
						? await saved.clearHistory()
						: await saved.clearPrivateFeedback();
					if (outcome.ok && isCurrent()) {
						if (history) this.setData({ history: [], historyCursor: null });
						else
							this.setData({
								feedback: [],
								feedbackRecords: [],
								feedbackCursor: null,
							});
					}
					return outcome;
				},
				history ? "账号历史已清空" : "私有反馈已清空",
			),
		);
	},

	async load(append: boolean) {
		const operation = this.operationGeneration;
		if (
			!this.isCurrentOperation(operation) ||
			this.data.busy ||
			this.data.sections.length === 0
		)
			return;
		this.setData({ busy: true, message: "", loginRequired: false });
		try {
			const saved = getApp<ChiShenMeMiniProgramApp>().globalData.saved;
			if (this.data.selected === "FAVORITES") {
				const outcome = await saved.listFavorites(
					append ? (this.data.favoritesCursor ?? undefined) : undefined,
				);
				if (!this.isCurrentOperation(operation)) return;
				if (!outcome.ok) return this.applyFailure(outcome);
				const records = append
					? distinctFavorites([
							...this.data.favoriteRecords,
							...outcome.value.items,
						])
					: [...outcome.value.items];
				this.setData({
					busy: false,
					favoriteRecords: records,
					favorites: records.map(viewFavorite),
					favoritesCursor: outcome.value.nextCursor,
					hasMore: outcome.value.nextCursor !== null,
				});
				return;
			}
			if (this.data.selected === "HISTORY") {
				const outcome = await saved.listHistory(
					append ? (this.data.historyCursor ?? undefined) : undefined,
				);
				if (!this.isCurrentOperation(operation)) return;
				if (!outcome.ok) return this.applyFailure(outcome);
				const records = append
					? distinctHistory([
							...this.data.history,
							...outcome.value.items.map(viewHistory),
						])
					: outcome.value.items.map(viewHistory);
				this.setData({
					busy: false,
					history: records,
					historyCursor: outcome.value.nextCursor,
					hasMore: outcome.value.nextCursor !== null,
				});
				return;
			}
			const outcome = await saved.listPrivateFeedback(
				append ? (this.data.feedbackCursor ?? undefined) : undefined,
			);
			if (!this.isCurrentOperation(operation)) return;
			if (!outcome.ok) return this.applyFailure(outcome);
			const records = append
				? distinctFeedback([
						...this.data.feedbackRecords,
						...outcome.value.items,
					])
				: [...outcome.value.items];
			this.setData({
				busy: false,
				feedbackRecords: records,
				feedback: records.map(viewFeedback),
				feedbackCursor: outcome.value.nextCursor,
				hasMore: outcome.value.nextCursor !== null,
			});
		} catch {
			this.applyUnexpectedFailure(operation);
		} finally {
			if (this.isCurrentOperation(operation)) this.setData({ busy: false });
		}
	},

	applyUnexpectedFailure(operation: number) {
		if (!this.isCurrentOperation(operation)) return;
		this.clearRecords();
		this.setData({
			loginRequired: false,
			message: "账号记录暂时不可用，请稍后重试。",
		});
	},

	applyFailure(outcome: { readonly kind: string; readonly message: string }) {
		if (
			["PRIVACY_REQUIRED", "RIGHTS_UNAVAILABLE", "LOGIN_REQUIRED"].includes(
				outcome.kind,
			)
		) {
			this.clearRecords();
			if (outcome.kind !== "LOGIN_REQUIRED") this.setData({ sections: [] });
		}
		this.setData({
			busy: false,
			loginRequired: outcome.kind === "LOGIN_REQUIRED",
			message: outcome.message,
			hasMore: false,
		});
	},

	async mutate(
		operation: (isCurrent: () => boolean) => Promise<{
			readonly ok: boolean;
			readonly kind?: string;
			readonly message?: string;
		}>,
		successMessage: string,
	) {
		const generation = this.operationGeneration;
		if (!this.isCurrentOperation(generation) || this.data.busy) return;
		this.setData({ busy: true, message: "" });
		try {
			const outcome = await operation(() =>
				this.isCurrentOperation(generation),
			);
			if (!this.isCurrentOperation(generation)) return;
			if (!outcome.ok) {
				this.applyFailure({
					kind: outcome.kind ?? "UNKNOWN",
					message: outcome.message ?? "操作失败",
				});
				return;
			}
			this.setData({ message: successMessage });
		} catch {
			this.applyUnexpectedFailure(generation);
		} finally {
			if (this.isCurrentOperation(generation)) this.setData({ busy: false });
		}
	},

	confirm(content: string, action: () => void) {
		const operation = this.operationGeneration;
		if (!this.isCurrentOperation(operation)) return;
		wx.showModal({
			title: "请确认",
			content,
			confirmText: "确认",
			success: (result) => {
				if (result.confirm && this.isCurrentOperation(operation)) action();
			},
		});
	},
});

function presentation(
	value:
		| FavoriteRecord["presentation"]
		| RecommendationHistoryItem["presentation"],
): {
	readonly name: string;
	readonly detail: string;
} {
	if (value === null)
		return { name: "餐厅展示信息不可用", detail: "该动作记录仍可单独删除" };
	if (value.presentationStatus === "TEMPORARILY_UNAVAILABLE") {
		return { name: "餐厅信息暂时不可用", detail: "稍后刷新可重试" };
	}
	if (value.presentationStatus === "RIGHTS_REVOKED") {
		return { name: "餐厅信息因授权变化不可展示", detail: "不会继续缓存旧信息" };
	}
	return {
		name: value.name,
		detail: [value.address, value.sourceLabel, value.dataMode]
			.filter(Boolean)
			.join(" · "),
	};
}

function viewFavorite(
	record: FavoriteRecord,
	index: number,
): Record<string, unknown> {
	return {
		index,
		...presentation(record.presentation),
		group: record.group === "WANT_TO_GO" ? "想去" : "常吃",
		nextGroup: record.group === "WANT_TO_GO" ? "移到常吃" : "移到想去",
		createdAt: record.createdAt.slice(0, 10),
	};
}

function viewHistory(
	record: RecommendationHistoryItem,
): Record<string, unknown> {
	return {
		id: record.historyId,
		...presentation(record.presentation),
		action: historyActionLabel(record.action),
		meal:
			record.mealPeriod === "BREAKFAST"
				? "早餐"
				: record.mealPeriod === "DINNER"
					? "晚餐"
					: "午餐",
		occurredAt: record.occurredAt.slice(0, 16).replace("T", " "),
	};
}

function viewFeedback(
	record: PrivateFeedbackRecord,
	index: number,
): Record<string, unknown> {
	return {
		index,
		...presentation(record.presentation),
		type: feedbackLabel(record.type),
		createdAt: record.createdAt.slice(0, 16).replace("T", " "),
	};
}

function historyActionLabel(
	value: RecommendationHistoryItem["action"],
): string {
	const labels: Record<RecommendationHistoryItem["action"], string> = {
		RECOMMENDATION_SHOWN: "看过推荐",
		DETAIL_VIEWED: "查看详情",
		FAVORITE_ADDED: "加入收藏",
		NAVIGATION_OPENED: "打开导航",
		PHONE_DIALER_OPENED: "打开拨号",
		REROLL_REQUESTED: "换一批",
	};
	return labels[value];
}

function feedbackLabel(value: PrivateFeedbackRecord["type"]): string {
	const labels: Record<PrivateFeedbackRecord["type"], string> = {
		WANT_TO_EAT: "想吃",
		ATE: "吃过",
		LIKE: "喜欢",
		DISLIKE: "不喜欢",
		TOO_FAR: "太远",
		TOO_EXPENSIVE: "太贵",
		RECENTLY_ATE: "最近吃过",
		AVOID_CUISINE: "避开该菜系",
	};
	return labels[value];
}

function distinctFavorites(
	values: readonly FavoriteRecord[],
): readonly FavoriteRecord[] {
	return values.filter(
		(item, index) =>
			values.findIndex((other) => other.favoriteId === item.favoriteId) ===
			index,
	);
}

function distinctFeedback(
	values: readonly PrivateFeedbackRecord[],
): readonly PrivateFeedbackRecord[] {
	return values.filter(
		(item, index) =>
			values.findIndex((other) => other.feedbackId === item.feedbackId) ===
			index,
	);
}

function distinctHistory(
	values: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
	return values.filter(
		(item, index) =>
			values.findIndex((other) => other.id === item.id) === index,
	);
}
