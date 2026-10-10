import { themedPage } from "../theme";
import type { ChiShenMeMiniProgramApp } from "../../app";
import {
	BUILT_IN_QUICK_LOCATIONS,
	CUISINE_PREFERENCES,
	type CuisinePreference,
	type DecisionState,
	type ExplorationMode,
	type MealPeriod,
	requireDecisionFeature,
	type TravelMode,
} from "../../features/decision/index";

interface InputEvent {
	readonly detail: { readonly value?: string | readonly string[] };
}

interface TapEvent {
	readonly currentTarget: {
		readonly dataset: Record<string, string | number | undefined>;
	};
}

interface PageNavigationRuntime {
	navigateTo(options: { readonly url: string }): void;
	hideShareMenu?(options?: { readonly menus?: string[] }): void;
}

const feature = requireDecisionFeature();
const controller = feature.controller;
const navigation = wx as unknown as PageNavigationRuntime;

themedPage({
	data: { ...viewData(controller.state), locationChooserOpen: false },
	unsubscribe: null as (() => void) | null,

	async onLoad() {
		navigation.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
		const app = getApp<ChiShenMeMiniProgramApp>().globalData;
		if (!app.consent.isAllowed()) {
			wx.reLaunch({ url: "/pages/consent/index" });
			return;
		}
		this.unsubscribe = controller.subscribe((state) =>
			this.setData(viewData(state)),
		);
		const initialized = await app.initializeAfterConsent();
		if (initialized.kind === "UPDATE_REQUIRED") {
			wx.reLaunch({
				url: `/pages/update/index?minimumVersion=${encodeURIComponent(initialized.minimumVersion)}`,
			});
		}
	},

	onHide() {
		controller.cancelLocation();
		controller.dismissLocationSearch();
	},

	onUnload() {
		this.unsubscribe?.();
		this.unsubscribe = null;
	},

	onLocate() {
		void controller.locate();
	},

	onToggleLocationChooser() {
		const open = !this.data.locationChooserOpen;
		this.setData({ locationChooserOpen: open });
		if (!open) controller.dismissLocationSearch();
	},

	onLocationQueryInput(event: InputEvent) {
		controller.updateLocationSearchQuery(String(event.detail.value ?? ""));
	},

	onSearchLocation() {
		void controller.searchLocation();
	},

	onSelectBuiltInLocation(event: TapEvent) {
		const index = Number(event.currentTarget.dataset.index);
		const choice = BUILT_IN_QUICK_LOCATIONS[index];
		if (choice !== undefined) {
			controller.setLocation(choice);
			this.setData({ locationChooserOpen: false });
		}
	},

	onSelectSearchLocation(event: TapEvent) {
		const index = Number(event.currentTarget.dataset.index);
		const search = controller.state.locationSearchState;
		if (search.status !== "READY") return;
		const place = search.response.results[index];
		if (place !== undefined) {
			controller.selectLocationSearchPlace(place, search.response.dataMode);
			this.setData({ locationChooserOpen: false });
		}
	},

	onDecisionMode(event: TapEvent) {
		const value = event.currentTarget.dataset.value;
		if (value === "QUICK" || value === "GUIDED")
			controller.setDecisionMode(value);
	},

	onMealPeriod(event: TapEvent) {
		const value = event.currentTarget.dataset.value;
		if (value === "BREAKFAST" || value === "LUNCH" || value === "DINNER") {
			controller.setMealPeriod(value);
		}
	},

	onTravelMode(event: TapEvent) {
		const value = event.currentTarget.dataset.value;
		if (value === "WALK" || value === "BIKE" || value === "TRANSIT") {
			controller.setTravelMode(value);
		}
	},

	onExplorationMode(event: TapEvent) {
		const value = event.currentTarget.dataset.value;
		if (value === "SAFE" || value === "BALANCED" || value === "ADVENTUROUS") {
			controller.setExplorationMode(value);
		}
	},

	onBudgetInput(event: InputEvent) {
		const text = String(event.detail.value ?? "").trim();
		controller.setBudget(text.length === 0 ? null : Number(text));
	},

	onMinutesInput(event: InputEvent) {
		controller.setAvailableMinutes(Number(event.detail.value));
	},

	onRadiusInput(event: InputEvent) {
		controller.setRadius(Number(event.detail.value));
	},

	onScenario(event: TapEvent) {
		const value = event.currentTarget.dataset.value;
		if (
			value === "IN_A_HURRY" ||
			value === "WORKDAY_LUNCH" ||
			value === "BUSINESS_TRIP"
		)
			controller.applyScenario(value);
	},

	onTarget(event: TapEvent) {
		const value = event.currentTarget.dataset.value;
		if (
			value === "MEAL" ||
			value === "MILK_TEA" ||
			value === "COFFEE" ||
			value === "DESSERT"
		)
			controller.setRecommendationTarget(value);
	},

	onWeather(event: TapEvent) {
		const value = event.currentTarget.dataset.value;
		if (value === "NONE") controller.setUserReportedWeather(null);
		if (
			value === "MINIMIZE_EXPOSURE" ||
			value === "WARMING" ||
			value === "COOLING"
		)
			controller.setUserReportedWeather(value);
	},

	onCuisine(event: TapEvent) {
		const cuisine = event.currentTarget.dataset.cuisine;
		const kind = event.currentTarget.dataset.kind;
		if (
			typeof cuisine === "string" &&
			isCuisine(cuisine) &&
			(kind === "preferred" || kind === "excluded")
		) {
			controller.toggleCuisine(cuisine, kind === "preferred");
		}
	},

	onAiPreference(event: InputEvent) {
		const selected = event.detail.value;
		const enabled = Array.isArray(selected) && selected.includes("AI");
		controller.setAiAssistancePreferred(enabled);
		getApp<ChiShenMeMiniProgramApp>().globalData.preferences.setAiAssistanceEnabled(
			enabled,
		);
	},

	async onRecommend() {
		if (!(await controller.recommend())) return;
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
		navigation.navigateTo({ url: "/pages/results/index" });
	},

	async onRetryConfig() {
		const initialized =
			await getApp<ChiShenMeMiniProgramApp>().globalData.initializeAfterConsent();
		if (initialized.kind === "UPDATE_REQUIRED") {
			wx.reLaunch({
				url: `/pages/update/index?minimumVersion=${encodeURIComponent(initialized.minimumVersion)}`,
			});
		}
	},

	onAccount() {
		navigation.navigateTo({ url: "/pages/account/index" });
	},

	onSaved() {
		navigation.navigateTo({ url: "/pages/saved/index" });
	},

	onSettings() {
		navigation.navigateTo({ url: "/pages/settings/index" });
	},
});

function viewData(state: DecisionState): Record<string, unknown> {
	const trusted =
		state.accessPolicy.state === "TRUSTED_COMPATIBLE" &&
		state.accessPolicy.recommendationsEnabled;
	const specialty = trusted
		? state.accessPolicy.specialtyCapabilities
		: undefined;
	const search = state.locationSearchState;
	const searchResults =
		search.status === "READY"
			? search.response.results.map((place, index) => ({
					index,
					name: place.name,
					address: place.address ?? "地址待确认",
					sourceLabel: place.sourceLabel,
				}))
			: [];
	const locationMessage =
		state.locationState.status === "FAILED"
			? state.locationState.message
			: state.locationState.status === "LOCATING"
				? "正在获取本次定位…"
				: null;
	const searchMessage =
		search.status === "FAILED"
			? search.message
			: search.status === "EMPTY"
				? "没有找到匹配地点，仍可使用下方内置地点"
				: null;
	return {
		locationLabel: state.form.location?.label ?? "尚未选择地点",
		locationMessage,
		locationQuery: state.locationSearchQuery,
		locationSearching: search.status === "LOADING",
		searchMessage,
		searchResults,
		builtInLocations: BUILT_IN_QUICK_LOCATIONS.map((choice, index) => ({
			index,
			label: choice.label,
			active: state.form.location?.label === choice.label,
		})),
		decisionModes: optionList(
			[
				["QUICK", "极速决定"],
				["GUIDED", "精细匹配"],
			] as const,
			state.form.decisionMode,
		),
		mealPeriods: optionList(
			[
				["BREAKFAST", "早餐"],
				["LUNCH", "午餐"],
				["DINNER", "晚餐"],
			] as const,
			state.form.mealPeriod,
		).filter(
			(item) =>
				item.value === "LUNCH" ||
				(item.value === "BREAKFAST"
					? specialty?.breakfastProfileEnabled
					: specialty?.dinnerProfileEnabled),
		),
		scenarios: [
			{ value: "IN_A_HURRY", label: "赶时间" },
			{ value: "WORKDAY_LUNCH", label: "工作日午餐" },
			{ value: "BUSINESS_TRIP", label: "旅行出差" },
		].map((item) => ({ ...item, active: state.activeScenario === item.value })),
		targets: [
			{ value: "MEAL", label: "吃顿饭", enabled: true },
			{
				value: "MILK_TEA",
				label: "奶茶",
				enabled: specialty?.milkTeaEnabled,
			},
			{
				value: "COFFEE",
				label: "咖啡",
				enabled: specialty?.coffeeEnabled,
			},
			{
				value: "DESSERT",
				label: "甜品",
				enabled: specialty?.dessertEnabled,
			},
		]
			.filter((item) => item.enabled)
			.map((item) => ({ ...item, active: state.form.target === item.value })),
		weatherEnabled: specialty?.userReportedWeatherEnabled === true,
		weatherOptions: [
			{ value: "NONE", label: "不设置" },
			{ value: "MINIMIZE_EXPOSURE", label: "少在户外停留" },
			{ value: "WARMING", label: "想吃暖一点" },
			{ value: "COOLING", label: "想吃清凉一点" },
		].map((item) => ({
			...item,
			active:
				item.value ===
				(state.form.weatherContext.kind === "NONE"
					? "NONE"
					: state.form.weatherContext.preference),
		})),
		travelModes: optionList(
			[
				["WALK", "步行"],
				["BIKE", "骑行"],
				["TRANSIT", "公交"],
			] as const,
			state.form.travelMode,
		),
		explorationModes: optionList(
			[
				["SAFE", "稳妥"],
				["BALANCED", "平衡"],
				["ADVENTUROUS", "尝鲜"],
			] as const,
			state.form.explorationMode,
		),
		cuisines: CUISINE_PREFERENCES.map((name) => ({
			name,
			preferred: state.form.preferredCuisines.includes(name),
			excluded: state.form.excludedCuisines.includes(name),
		})),
		isGuided: state.form.decisionMode === "GUIDED",
		budget: state.form.budgetMaxYuan ?? "",
		availableMinutes: state.form.availableMinutes,
		radiusMeters: state.form.radiusMeters,
		maximumRadiusMeters:
			state.accessPolicy.recommendationDefaults?.maximumRadiusMeters ?? 10_000,
		aiAvailable:
			trusted &&
			state.accessPolicy.aiEnabled &&
			state.form.target === "MEAL" &&
			state.form.mealPeriod === "LUNCH" &&
			state.form.weatherContext.kind === "NONE",
		softPreferencesAvailable:
			trusted && state.accessPolicy.dataRightsMode === "LICENSED_ENRICHMENT",
		quickSummary: `${state.form.budgetMaxYuan === null ? "预算不限" : `${state.form.budgetMaxYuan} 元以内`} · ${state.form.availableMinutes} 分钟 · ${state.form.radiusMeters} 米以内`,
		locationSelected: state.form.location !== null,
		locationSearchEnabled: state.accessPolicy.locationSearchEnabled,
		aiAssistancePreferred: state.form.aiAssistancePreferred,
		recommendationLoading: state.recommendation.status === "LOADING",
		formError:
			state.formError ??
			(state.recommendation.status === "FAILED"
				? state.recommendation.message
				: null),
		remoteReady: trusted,
	};
}

function optionList<
	T extends MealPeriod | TravelMode | ExplorationMode | "QUICK" | "GUIDED",
>(
	options: readonly (readonly [T, string])[],
	selected: T,
): readonly Record<string, unknown>[] {
	return options.map(([value, label]) => ({
		value,
		label,
		active: value === selected,
	}));
}

function isCuisine(value: string): value is CuisinePreference {
	return (CUISINE_PREFERENCES as readonly string[]).includes(value);
}
