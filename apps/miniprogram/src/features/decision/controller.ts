import { type DecisionApi, DecisionApiError, recommendationEvent } from "./api";
import { type LocationProvider, LocationProviderError } from "./location";
import { ResultSessionStore } from "./session";
import type {
	CuisinePreference,
	DecisionAccessPolicy,
	DecisionForm,
	DecisionMode,
	DecisionScenario,
	DecisionState,
	ExplorationMode,
	LocationChoice,
	LocationSearchPlace,
	MealPeriod,
	RecommendationEventType,
	RecommendationLoadState,
	RecommendationPreferenceVector,
	RecommendationTarget,
	TravelMode,
	UserReportedWeatherPreference,
} from "./types";
import { DEFAULT_PREFERENCE_VECTOR } from "./types";
import {
	buildRecommendationContext,
	validateDecisionForm,
	validateLocationSearchQuery,
} from "./validation";

export type DecisionStateListener = (state: DecisionState) => void;

const UNCONFIRMED_POLICY: DecisionAccessPolicy = Object.freeze({
	generation: 0,
	state: "UNCONFIRMED",
	recommendationsEnabled: false,
	locationSearchEnabled: false,
	aiEnabled: false,
});

export class DecisionController {
	readonly sessions: ResultSessionStore;
	private currentState: DecisionState;
	private readonly listeners = new Set<DecisionStateListener>();
	private lastSubmittedForm: DecisionForm | null = null;
	private recommendationSequence = 0;
	private locationSequence = 0;
	private locationSearchSequence = 0;
	private disposed = false;
	private radiusExplicitlySelected = false;

	constructor(
		private readonly api: DecisionApi,
		private readonly locationProvider: LocationProvider,
		sessions: ResultSessionStore | undefined = undefined,
		private readonly now: () => Date = () => new Date(),
	) {
		this.sessions = sessions ?? new ResultSessionStore(now);
		this.currentState = Object.freeze({
			activeScenario: null,
			form: defaultDecisionForm(now()),
			formError: null,
			locationState: Object.freeze({ status: "IDLE" }),
			locationSearchQuery: "",
			locationSearchState: Object.freeze({ status: "IDLE" }),
			recommendation: Object.freeze({ status: "IDLE" }),
			accessPolicy: UNCONFIRMED_POLICY,
		});
		this.sessions.markConfigurationUnconfirmed(0);
	}

	get state(): DecisionState {
		return this.currentState;
	}

	subscribe(listener: DecisionStateListener): () => void {
		this.listeners.add(listener);
		listener(this.currentState);
		return () => this.listeners.delete(listener);
	}

	setAccessPolicy(policy: DecisionAccessPolicy): void {
		if (
			!Number.isInteger(policy.generation) ||
			policy.generation < this.currentState.accessPolicy.generation
		) {
			return;
		}
		const normalized = Object.freeze({ ...policy });
		const changedGeneration =
			policy.generation !== this.currentState.accessPolicy.generation;
		if (changedGeneration || policy.state !== "TRUSTED_COMPATIBLE") {
			this.recommendationSequence += 1;
			this.locationSearchSequence += 1;
			this.lastSubmittedForm = null;
		}
		switch (policy.state) {
			case "TRUSTED_COMPATIBLE":
				this.sessions.confirmConfiguration(policy.generation);
				break;
			case "UNCONFIRMED":
				this.sessions.markConfigurationUnconfirmed(policy.generation);
				break;
			case "UNAVAILABLE_RULES_ONLY":
			case "INCOMPATIBLE":
				this.sessions.markConfigurationUnavailable(policy.generation);
				break;
		}
		this.replace({
			accessPolicy: normalized,
			form:
				policy.state === "TRUSTED_COMPATIBLE" && !this.radiusExplicitlySelected
					? copyForm({
							...this.currentState.form,
							radiusMeters:
								policy.recommendationDefaults?.defaultRadiusMeters ??
								automaticRadius(this.currentState.form.mealPeriod),
						})
					: this.currentState.form,
			recommendation:
				changedGeneration || policy.state !== "TRUSTED_COMPATIBLE"
					? Object.freeze({ status: "IDLE" })
					: this.currentState.recommendation,
			locationSearchQuery:
				changedGeneration || policy.state !== "TRUSTED_COMPATIBLE"
					? ""
					: this.currentState.locationSearchQuery,
			locationSearchState:
				changedGeneration || policy.state !== "TRUSTED_COMPATIBLE"
					? Object.freeze({ status: "IDLE" })
					: this.currentState.locationSearchState,
		});
	}

	beginConfigurationRefresh(generation: number): void {
		this.setAccessPolicy({
			generation,
			state: "UNCONFIRMED",
			recommendationsEnabled: false,
			locationSearchEnabled: false,
			aiEnabled: false,
		});
	}

	setDecisionMode(value: DecisionMode): void {
		this.updateForm({ decisionMode: value });
	}

	setMealPeriod(value: MealPeriod): void {
		const capabilities = this.trustedSpecialtyCapabilities();
		if (
			(value === "BREAKFAST" &&
				capabilities?.breakfastProfileEnabled !== true) ||
			(value === "DINNER" && capabilities?.dinnerProfileEnabled !== true)
		) {
			this.replace({ formError: "该餐段专项当前未开放，请先选择午餐" });
			return;
		}
		const radiusMeters = this.radiusExplicitlySelected
			? this.currentState.form.radiusMeters
			: (this.currentState.accessPolicy.recommendationDefaults
					?.defaultRadiusMeters ?? automaticRadius(value));
		this.updateForm({ mealPeriod: value, radiusMeters });
	}

	setRecommendationTarget(value: RecommendationTarget): void {
		const capabilities = this.trustedSpecialtyCapabilities();
		if (
			(value === "MILK_TEA" && capabilities?.milkTeaEnabled !== true) ||
			(value === "COFFEE" && capabilities?.coffeeEnabled !== true) ||
			(value === "DESSERT" && capabilities?.dessertEnabled !== true)
		) {
			this.replace({ formError: "该专项推荐当前未开放，请先使用普通用餐模式" });
			return;
		}
		this.updateForm({ target: value });
	}

	setUserReportedWeather(value: UserReportedWeatherPreference | null): void {
		if (
			value !== null &&
			this.trustedSpecialtyCapabilities()?.userReportedWeatherEnabled !== true
		) {
			this.replace({ formError: "手动体感推荐当前未开放" });
			return;
		}
		this.updateForm({
			weatherContext:
				value === null
					? { kind: "NONE" }
					: { kind: "USER_REPORTED", preference: value },
		});
	}

	setPreferenceWeight(
		key: keyof RecommendationPreferenceVector,
		value: number,
	): void {
		const policy = this.currentState.accessPolicy;
		if (
			policy.state !== "TRUSTED_COMPATIBLE" ||
			policy.dataRightsMode !== "LICENSED_ENRICHMENT"
		) {
			this.replace({ formError: "当前数据授权模式不支持个性化排序偏好" });
			return;
		}
		if (
			!(key in DEFAULT_PREFERENCE_VECTOR) ||
			!Number.isInteger(value) ||
			value < 0 ||
			value > 100
		)
			return;
		this.updateForm({
			preferenceVector: {
				...this.currentState.form.preferenceVector,
				[key]: value,
			},
		});
	}

	applyScenario(value: DecisionScenario): void {
		const presets: Record<DecisionScenario, Partial<DecisionForm>> = {
			IN_A_HURRY: {
				decisionMode: "QUICK",
				travelMode: "WALK",
				explorationMode: "SAFE",
				budgetMaxYuan: 25,
				availableMinutes: 30,
				radiusMeters: 1_000,
			},
			WORKDAY_LUNCH: {
				mealPeriod: "LUNCH",
				decisionMode: "QUICK",
				travelMode: "WALK",
				explorationMode: "BALANCED",
				budgetMaxYuan: 25,
				availableMinutes: 45,
				radiusMeters: 1_500,
			},
			BUSINESS_TRIP: {
				decisionMode: "GUIDED",
				travelMode: "WALK",
				explorationMode: "BALANCED",
				budgetMaxYuan: 40,
				availableMinutes: 60,
				radiusMeters: 1_500,
			},
		};
		if (!Object.keys(presets).includes(value)) return;
		this.radiusExplicitlySelected = true;
		this.updateForm(presets[value]);
		this.replace({
			activeScenario: value,
			formError: this.radiusValidationMessage(),
		});
	}

	setBudget(value: number | null): void {
		this.updateForm({ budgetMaxYuan: value });
	}

	setAvailableMinutes(value: number): void {
		this.updateForm({ availableMinutes: value });
	}

	setRadius(value: number): void {
		this.radiusExplicitlySelected = true;
		this.updateForm({ radiusMeters: value });
		this.replace({ formError: this.radiusValidationMessage() });
	}

	setTravelMode(value: TravelMode): void {
		this.updateForm({ travelMode: value });
	}

	setExplorationMode(value: ExplorationMode): void {
		this.updateForm({ explorationMode: value });
	}

	setPartySize(value: number): void {
		if (value !== 1) this.replace({ formError: "当前仅支持单人决策" });
	}

	setAiAssistancePreferred(value: boolean): void {
		this.updateForm({ aiAssistancePreferred: value });
	}

	toggleCuisine(cuisine: CuisinePreference, preferred: boolean): void {
		const selected = preferred
			? this.currentState.form.preferredCuisines
			: this.currentState.form.excludedCuisines;
		const next = selected.includes(cuisine)
			? selected.filter((item) => item !== cuisine)
			: [...selected, cuisine];
		this.updateForm(
			preferred
				? {
						preferredCuisines: next,
						excludedCuisines: this.currentState.form.excludedCuisines.filter(
							(item) => item !== cuisine,
						),
					}
				: {
						excludedCuisines: next,
						preferredCuisines: this.currentState.form.preferredCuisines.filter(
							(item) => item !== cuisine,
						),
					},
		);
	}

	setLocation(choice: LocationChoice): void {
		this.locationProvider.cancel?.();
		this.locationSequence += 1;
		this.updateForm({ location: copyLocation(choice) });
		this.replace({
			locationState: Object.freeze({
				status: "READY",
				choice: copyLocation(choice),
			}),
			locationSearchQuery: "",
			locationSearchState: Object.freeze({ status: "IDLE" }),
		});
	}

	selectLocationSearchPlace(
		place: LocationSearchPlace,
		dataMode: "LIVE" | "DEMO",
	): void {
		this.setLocation({
			label: place.name,
			coordinate:
				place.location.accuracyMeters === undefined
					? {
							latitude: place.location.latitude,
							longitude: place.location.longitude,
							crs: place.location.crs,
						}
					: { ...place.location },
			isDemonstration: dataMode === "DEMO",
			isApproximate: false,
		});
	}

	async locate(): Promise<boolean> {
		const sequence = ++this.locationSequence;
		this.replace({
			locationState: Object.freeze({ status: "LOCATING" }),
			formError: null,
		});
		try {
			const choice = await this.locationProvider.currentLocation();
			if (!this.active(sequence, "location")) return false;
			this.setLocation(choice);
			return true;
		} catch (error) {
			if (!this.active(sequence, "location")) return false;
			const failure =
				error instanceof LocationProviderError
					? error
					: new LocationProviderError(
							"UNAVAILABLE",
							"暂时无法定位，请手动选择地点",
						);
			this.replace({
				locationState: Object.freeze({
					status: "FAILED",
					kind: failure.kind,
					message: failure.message,
				}),
			});
			return false;
		}
	}

	cancelLocation(): void {
		this.locationProvider.cancel?.();
		this.locationSequence += 1;
		if (this.currentState.locationState.status === "LOCATING") {
			this.replace({ locationState: Object.freeze({ status: "IDLE" }) });
		}
	}

	updateLocationSearchQuery(value: string): void {
		this.locationSearchSequence += 1;
		this.replace({
			locationSearchQuery: [...value].slice(0, 81).join(""),
			locationSearchState: Object.freeze({ status: "IDLE" }),
		});
	}

	async searchLocation(): Promise<boolean> {
		const validation = validateLocationSearchQuery(
			this.currentState.locationSearchQuery,
		);
		if (!validation.valid) {
			this.locationSearchSequence += 1;
			this.replace({
				locationSearchState: Object.freeze({
					status: "FAILED",
					message: validation.message,
				}),
			});
			return false;
		}
		const policy = this.currentState.accessPolicy;
		if (
			policy.state !== "TRUSTED_COMPATIBLE" ||
			!policy.locationSearchEnabled
		) {
			this.locationSearchSequence += 1;
			this.replace({
				locationSearchState: Object.freeze({
					status: "FAILED",
					message: remoteBlockedMessage(
						policy.state,
						"地点搜索服务当前未开放，请选择下方内置地点",
					),
				}),
			});
			return false;
		}
		const sequence = ++this.locationSearchSequence;
		const generation = policy.generation;
		this.replace({ locationSearchState: Object.freeze({ status: "LOADING" }) });
		try {
			const response = await this.api.searchLocation(validation.query);
			if (!this.locationSearchCurrent(sequence, generation)) return false;
			this.replace({
				locationSearchState: Object.freeze({
					status: response.results.length === 0 ? "EMPTY" : "READY",
					response,
				}),
			});
			return response.results.length > 0;
		} catch (error) {
			if (!this.locationSearchCurrent(sequence, generation)) return false;
			this.replace({
				locationSearchState: Object.freeze({
					status: "FAILED",
					message: locationSearchError(error),
				}),
			});
			return false;
		}
	}

	dismissLocationSearch(): void {
		this.locationSearchSequence += 1;
		this.replace({
			locationSearchQuery: "",
			locationSearchState: Object.freeze({ status: "IDLE" }),
		});
	}

	recommend(): Promise<boolean> {
		const form = copyForm(this.currentState.form);
		const validation = validateDecisionForm(
			form,
			this.currentState.accessPolicy,
		);
		if (!validation.valid) {
			this.replace({
				formError: validation.message,
				recommendation: Object.freeze({ status: "IDLE" }),
			});
			return Promise.resolve(false);
		}
		this.lastSubmittedForm = form;
		return this.runRecommendation(form);
	}

	retry(): Promise<boolean> {
		return this.runRecommendation(
			copyForm(this.lastSubmittedForm ?? this.currentState.form),
		);
	}

	reroll(): Promise<boolean> {
		const ready = this.currentState.recommendation;
		if (ready.status === "READY") {
			const first = ready.response.results[0];
			if (first !== undefined) this.record("REROLL", first.resultToken);
		}
		return this.retry();
	}

	record(type: RecommendationEventType, resultToken: string): void {
		if (this.sessions.state(resultToken) !== "CURRENT") return;
		const response = this.sessions.currentResponse();
		const result = response?.results.find(
			(item) => item.resultToken === resultToken,
		);
		if (response === null || result === undefined) return;
		// Favorite persistence has its own capability gate outside this feature.
		if (type === "FAVORITE") return;
		if (type === "NAVIGATION" && !result.actions.navigate) return;
		if (type === "CALL" && !result.actions.call) return;
		try {
			const event = recommendationEvent(
				response.requestId,
				resultToken,
				type,
				this.now,
			);
			void this.api.recordEvent(event).catch(() => undefined);
		} catch {
			// Events are best-effort and never interrupt the decision flow.
		}
	}

	selectResultForDetail(resultToken: string): boolean {
		const selected = this.sessions.select(resultToken);
		if (selected) this.record("DETAIL", resultToken);
		return selected;
	}

	clearSelectedResult(): void {
		this.sessions.clearSelection();
	}

	clearSensitiveState(): void {
		this.locationProvider.cancel?.();
		this.radiusExplicitlySelected = false;
		this.locationSequence += 1;
		this.locationSearchSequence += 1;
		this.recommendationSequence += 1;
		this.lastSubmittedForm = null;
		this.sessions.expire();
		this.replace({
			form: defaultDecisionForm(this.now()),
			activeScenario: null,
			formError: null,
			locationState: Object.freeze({ status: "IDLE" }),
			locationSearchQuery: "",
			locationSearchState: Object.freeze({ status: "IDLE" }),
			recommendation: Object.freeze({ status: "IDLE" }),
		});
	}

	dispose(): void {
		this.locationProvider.cancel?.();
		this.disposed = true;
		this.locationSequence += 1;
		this.locationSearchSequence += 1;
		this.recommendationSequence += 1;
		this.listeners.clear();
		this.sessions.expire();
	}

	private async runRecommendation(form: DecisionForm): Promise<boolean> {
		const validation = validateDecisionForm(
			form,
			this.currentState.accessPolicy,
		);
		if (!validation.valid) {
			this.replace({
				formError: validation.message,
				recommendation: Object.freeze({ status: "IDLE" }),
			});
			return false;
		}
		const policy = this.currentState.accessPolicy;
		if (
			policy.state !== "TRUSTED_COMPATIBLE" ||
			!policy.recommendationsEnabled
		) {
			this.replace({
				formError: remoteBlockedMessage(
					policy.state,
					"餐厅推荐服务当前未开放，请稍后重试",
				),
				recommendation: Object.freeze({ status: "IDLE" }),
			});
			return false;
		}

		const context = buildRecommendationContext(
			{
				...form,
				preferenceVector:
					policy.dataRightsMode === "LICENSED_ENRICHMENT"
						? form.preferenceVector
						: DEFAULT_PREFERENCE_VECTOR,
			},
			policy.aiEnabled &&
				form.aiAssistancePreferred &&
				form.target === "MEAL" &&
				form.mealPeriod === "LUNCH" &&
				form.weatherContext.kind === "NONE",
			this.now,
		);
		const sequence = ++this.recommendationSequence;
		const generation = policy.generation;
		this.sessions.clearSelection();
		this.replace({
			recommendation: Object.freeze({ status: "LOADING" }),
			formError: null,
		});
		try {
			const response = await this.api.recommend(context);
			if (!this.recommendationCurrent(sequence, generation)) return false;
			const ready: RecommendationLoadState = Object.freeze({
				status: "READY",
				response,
				context,
				configurationGeneration: generation,
				trustedCompatibleConfiguration: true,
			});
			this.sessions.install(response, context, generation, true);
			this.replace({ recommendation: ready });
			response.results.forEach((result) => {
				this.record("IMPRESSION", result.resultToken);
			});
			return true;
		} catch (error) {
			if (!this.recommendationCurrent(sequence, generation)) return false;
			this.replace({
				recommendation: Object.freeze({
					status: "FAILED",
					message: recommendationError(error),
				}),
			});
			return false;
		}
	}

	private updateForm(patch: Partial<DecisionForm>): void {
		this.recommendationSequence += 1;
		this.lastSubmittedForm = null;
		this.sessions.clearResult();
		this.replace({
			activeScenario: null,
			recommendation: Object.freeze({ status: "IDLE" }),
			form: copyForm({ ...this.currentState.form, ...patch }),
			formError: null,
		});
	}

	private trustedSpecialtyCapabilities() {
		const policy = this.currentState.accessPolicy;
		return policy.state === "TRUSTED_COMPATIBLE" &&
			policy.recommendationsEnabled
			? policy.specialtyCapabilities
			: undefined;
	}

	private radiusValidationMessage(): string | null {
		const maximum =
			this.currentState.accessPolicy.recommendationDefaults
				?.maximumRadiusMeters ?? 10_000;
		const radius = this.currentState.form.radiusMeters;
		return radius > maximum
			? `当前服务最远支持 ${maximum} 米，你选择了 ${radius} 米。请调整最远距离后重试。`
			: null;
	}

	private replace(patch: Partial<DecisionState>): void {
		if (this.disposed) return;
		this.currentState = Object.freeze({ ...this.currentState, ...patch });
		this.listeners.forEach((listener) => {
			listener(this.currentState);
		});
	}

	private active(sequence: number, target: "location"): boolean {
		return (
			!this.disposed &&
			target === "location" &&
			sequence === this.locationSequence
		);
	}

	private locationSearchCurrent(sequence: number, generation: number): boolean {
		const policy = this.currentState.accessPolicy;
		return (
			!this.disposed &&
			sequence === this.locationSearchSequence &&
			policy.generation === generation &&
			policy.state === "TRUSTED_COMPATIBLE" &&
			policy.locationSearchEnabled
		);
	}

	private recommendationCurrent(sequence: number, generation: number): boolean {
		const policy = this.currentState.accessPolicy;
		return (
			!this.disposed &&
			sequence === this.recommendationSequence &&
			policy.generation === generation &&
			policy.state === "TRUSTED_COMPATIBLE" &&
			policy.recommendationsEnabled
		);
	}
}

export function defaultDecisionForm(_now = new Date()): DecisionForm {
	const mealPeriod: MealPeriod = "LUNCH";
	return Object.freeze({
		target: "MEAL",
		weatherContext: Object.freeze({ kind: "NONE" }),
		preferenceVector: DEFAULT_PREFERENCE_VECTOR,
		location: null,
		mealPeriod,
		decisionMode: "QUICK",
		travelMode: "WALK",
		explorationMode: "BALANCED",
		budgetMaxYuan: 25,
		availableMinutes: 60,
		radiusMeters: 1_500,
		partySize: 1,
		excludedCuisines: Object.freeze([]),
		preferredCuisines: Object.freeze([]),
		aiAssistancePreferred: true,
	});
}

function copyForm(form: DecisionForm): DecisionForm {
	return Object.freeze({
		...form,
		weatherContext: Object.freeze({ ...form.weatherContext }),
		preferenceVector: Object.freeze({ ...form.preferenceVector }),
		location: form.location === null ? null : copyLocation(form.location),
		excludedCuisines: Object.freeze([...form.excludedCuisines]),
		preferredCuisines: Object.freeze([...form.preferredCuisines]),
	});
}

function automaticRadius(value: MealPeriod): number {
	return value === "BREAKFAST" ? 1_000 : value === "LUNCH" ? 1_500 : 3_000;
}

function copyLocation(choice: LocationChoice): LocationChoice {
	return Object.freeze({
		...choice,
		coordinate: Object.freeze({ ...choice.coordinate }),
	});
}

function remoteBlockedMessage(
	state: DecisionAccessPolicy["state"],
	unavailableMessage: string,
): string {
	if (state === "UNCONFIRMED") return "正在确认服务配置，请稍后重试";
	if (state === "INCOMPATIBLE")
		return "当前小程序版本与服务不兼容，请更新后重试";
	return unavailableMessage;
}

function locationSearchError(error: unknown): string {
	if (!(error instanceof DecisionApiError))
		return "暂时无法搜索地点，仍可选择内置地点";
	if (error.kind === "NETWORK") return "网络不可用，仍可选择下方内置地点";
	if (error.kind === "CONTRACT_INCOMPATIBLE")
		return "当前小程序与地点搜索服务版本不兼容";
	if (error.kind === "INVALID_RESPONSE")
		return "地点搜索结果未通过安全校验，请重试";
	if (error.status === 400) return "地点关键词无法搜索，请换一种写法";
	if (error.status === 429) return "搜索请求有点多，请稍后重试";
	if (error.status !== null && error.status >= 500)
		return "地点搜索服务暂时不可用，仍可选择内置地点";
	return `地点搜索失败${error.status === null ? "" : `（${error.status}）`}`;
}

function recommendationError(error: unknown): string {
	if (!(error instanceof DecisionApiError)) return "暂时无法生成推荐，请重试";
	if (error.kind === "NETWORK") return "网络不可用，请检查连接后重试";
	if (error.kind === "CONTRACT_INCOMPATIBLE")
		return "当前小程序与推荐服务版本不兼容";
	if (error.kind === "INVALID_RESPONSE") return "服务返回的数据未通过安全校验";
	if (error.status === 400) return "推荐条件有误，请调整后重试";
	if (error.status === 429) return "请求有点多，请稍后再试";
	if (error.status !== null && error.status >= 500)
		return "推荐服务暂时不可用，请稍后重试";
	return `请求失败${error.status === null ? "" : `（${error.status}）`}`;
}
