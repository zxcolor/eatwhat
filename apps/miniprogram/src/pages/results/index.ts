import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import {
	type DecisionState,
	requireDecisionFeature,
} from "../../features/decision/index";
import {
	projectResultCards,
	type ResultsFilter,
	resultCountSummary,
} from "./model";

interface InputEvent {
	readonly detail: { readonly value?: string | readonly string[] };
}

interface TapEvent {
	readonly currentTarget: {
		readonly dataset: Record<string, string | number | undefined>;
	};
}

interface ResultsPageRuntime {
	navigateTo(options: { readonly url: string }): void;
	navigateBack(options?: { readonly delta?: number }): void;
	showToast(options: {
		readonly title: string;
		readonly icon: "none" | "success";
	}): void;
	hideShareMenu?(options?: { readonly menus?: string[] }): void;
}

const feature = requireDecisionFeature();
const controller = feature.controller;
const runtime = wx as unknown as ResultsPageRuntime;

themedPage({
	data: emptyView(),
	filter: {
		openNowOnly: false,
		knownPriceWithinBudgetOnly: false,
		cuisineTagQuery: "",
	} as ResultsFilter,
	unsubscribe: null as (() => void) | null,

	onLoad() {
		runtime.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
		if (!getApp<ChiShenMeMiniProgramApp>().globalData.consent.isAllowed()) {
			wx.reLaunch({ url: "/pages/consent/index" });
			return;
		}
		this.unsubscribe = controller.subscribe((state) => this.render(state));
	},

	onUnload() {
		this.unsubscribe?.();
		this.unsubscribe = null;
	},

	render(state: DecisionState) {
		const ready = state.recommendation;
		if (ready.status !== "READY") {
			this.setData({
				...emptyView(),
				loading: ready.status === "LOADING",
				error:
					ready.status === "FAILED"
						? ready.message
						: "本次推荐已失效，请返回重新获取",
			});
			return;
		}
		const cards = projectResultCards(
			ready.response,
			ready.context,
			this.filter,
		);
		this.setData({
			loading: false,
			error: null,
			notice: ready.response.notice,
			rulesOnly: !ready.trustedCompatibleConfiguration,
			cards,
			countSummary: resultCountSummary(
				cards.length,
				ready.response.results.length,
				this.filter,
				ready.response.dataRightsMode === "LIVE_DISPLAY_ONLY",
			),
			liveDisplayOnly: ready.response.dataRightsMode === "LIVE_DISPLAY_ONLY",
			emptyByFilter: cards.length === 0 && ready.response.results.length > 0,
			noRecommendations: ready.response.results.length === 0,
			rerolling: false,
			openNowOnly: this.filter.openNowOnly,
			knownPriceOnly: this.filter.knownPriceWithinBudgetOnly,
			cuisineTagQuery: this.filter.cuisineTagQuery,
		});
	},

	onOpenFilter(event: InputEvent) {
		this.filter = { ...this.filter, openNowOnly: selected(event, "OPEN") };
		this.render(controller.state);
	},

	onPriceFilter(event: InputEvent) {
		this.filter = {
			...this.filter,
			knownPriceWithinBudgetOnly: selected(event, "PRICE"),
		};
		this.render(controller.state);
	},

	onCuisineInput(event: InputEvent) {
		this.filter = {
			...this.filter,
			cuisineTagQuery: String(event.detail.value ?? "").slice(0, 40),
		};
		this.render(controller.state);
	},

	onOpenDetail(event: TapEvent) {
		const resultIndex = Number(event.currentTarget.dataset.index);
		const ready = controller.state.recommendation;
		if (ready.status !== "READY") return;
		const result = ready.response.results[resultIndex];
		if (
			result === undefined ||
			!controller.selectResultForDetail(result.resultToken)
		) {
			runtime.showToast({ title: "本次结果已失效，请重新获取", icon: "none" });
			return;
		}
		// No restaurant fields or opaque token are serialized into the route.
		runtime.navigateTo({ url: "/pages/detail/index" });
	},

	async onReroll() {
		this.setData({ rerolling: true });
		const ok = await controller.reroll();
		this.setData({ rerolling: false });
		if (!ok) {
			runtime.showToast({
				title: "暂时无法重新推荐，请稍后重试",
				icon: "none",
			});
			return;
		}
		const ready = controller.state.recommendation;
		if (ready.status === "READY") {
			getApp<ChiShenMeMiniProgramApp>().globalData.preferences.recordDecision({
				mealPeriod: ready.context.mealPeriod,
				decisionMode: ready.context.decisionMode,
				travelMode: ready.context.travelMode,
				budgetMaxYuan: ready.context.budgetMaxYuan,
				availableMinutes: ready.context.availableMinutes,
				resultCount: ready.response.results.length,
			});
		}
	},

	onBack() {
		runtime.navigateBack({ delta: 1 });
	},
});

function emptyView(): Record<string, unknown> {
	return {
		loading: false,
		error: null,
		notice: null,
		rulesOnly: false,
		liveDisplayOnly: false,
		cards: [],
		countSummary: "本次共 0 条推荐",
		emptyByFilter: false,
		noRecommendations: false,
		rerolling: false,
		openNowOnly: false,
		knownPriceOnly: false,
		cuisineTagQuery: "",
	};
}

function selected(event: InputEvent, value: string): boolean {
	return (
		Array.isArray(event.detail.value) && event.detail.value.includes(value)
	);
}
