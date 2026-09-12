import type {
	MealPeriod,
	RecommendationContext,
	RecommendationTarget,
	WeatherQueryModifier,
} from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import {
	coordinateReferenceSystem,
	estimateTravelMinutes,
	haversineDistanceMetersUnrounded,
} from "../domain/geo.js";
import type {
	PlaceCandidate,
	PlaceProvider,
} from "../domain/place-candidate.js";
import type { RecommendationQueryPlan } from "../domain/recommendation-query-plan.js";

interface DemoTemplate {
	readonly id: string;
	readonly name: string;
	readonly northMeters: number;
	readonly eastMeters: number;
	readonly rating: number | null;
	readonly cost: number | null;
	readonly mealMinutes: number;
	readonly tags: readonly string[];
}

const DEMO_TEMPLATES: readonly DemoTemplate[] = Object.freeze([
	{
		id: "demo-noodle-001",
		name: "演示·校园面馆",
		northMeters: 120,
		eastMeters: 90,
		rating: 4.5,
		cost: 22,
		mealMinutes: 28,
		tags: ["面食", "快餐"],
	},
	{
		id: "demo-rice-002",
		name: "演示·家常盖饭",
		northMeters: -230,
		eastMeters: 210,
		rating: 4.3,
		cost: 26,
		mealMinutes: 32,
		tags: ["盖饭", "家常菜"],
	},
	{
		id: "demo-dumpling-003",
		name: "演示·北方饺子铺",
		northMeters: 350,
		eastMeters: -260,
		rating: 4.4,
		cost: 30,
		mealMinutes: 38,
		tags: ["饺子", "面食"],
	},
	{
		id: "demo-canteen-004",
		name: "演示·邻里食堂",
		northMeters: -480,
		eastMeters: -250,
		rating: null,
		cost: 18,
		mealMinutes: 26,
		tags: ["简餐", "快餐"],
	},
	{
		id: "demo-hunan-005",
		name: "演示·湘味小馆",
		northMeters: 640,
		eastMeters: 350,
		rating: 4.6,
		cost: 48,
		mealMinutes: 55,
		tags: ["湘菜", "正餐"],
	},
	{
		id: "demo-hotpot-006",
		name: "演示·同学小火锅",
		northMeters: -780,
		eastMeters: 480,
		rating: 4.2,
		cost: 68,
		mealMinutes: 75,
		tags: ["火锅", "聚餐"],
	},
]);

const VERTICAL_DEMO_TEMPLATES: Readonly<
	Record<Exclude<RecommendationTarget, "MEAL">, readonly DemoTemplate[]>
> = Object.freeze({
	MILK_TEA: Object.freeze([
		{
			id: "demo-milk-tea-cloud-001",
			name: "演示·云朵奶茶实验室",
			northMeters: 140,
			eastMeters: 60,
			rating: 4.5,
			cost: 18,
			mealMinutes: 18,
			tags: ["奶茶", "茶饮"],
		},
		{
			id: "demo-milk-tea-pixel-002",
			name: "演示·像素果茶铺",
			northMeters: -210,
			eastMeters: 180,
			rating: 4.3,
			cost: 16,
			mealMinutes: 16,
			tags: ["果茶", "茶饮"],
		},
		{
			id: "demo-milk-tea-star-003",
			name: "演示·星球奶盖站",
			northMeters: 300,
			eastMeters: -220,
			rating: 4.4,
			cost: 20,
			mealMinutes: 20,
			tags: ["奶盖", "奶茶"],
		},
		{
			id: "demo-milk-tea-paper-004",
			name: "演示·纸飞机茶饮屋",
			northMeters: -420,
			eastMeters: -190,
			rating: null,
			cost: 14,
			mealMinutes: 15,
			tags: ["纯茶", "茶饮"],
		},
	]),
	COFFEE: Object.freeze([
		{
			id: "demo-coffee-orbit-001",
			name: "演示·轨道咖啡舱",
			northMeters: 110,
			eastMeters: 120,
			rating: 4.6,
			cost: 26,
			mealMinutes: 22,
			tags: ["咖啡", "手冲"],
		},
		{
			id: "demo-coffee-clock-002",
			name: "演示·九点钟咖啡馆",
			northMeters: -240,
			eastMeters: 190,
			rating: 4.4,
			cost: 24,
			mealMinutes: 20,
			tags: ["咖啡", "拿铁"],
		},
		{
			id: "demo-coffee-forest-003",
			name: "演示·纸上森林咖啡",
			northMeters: 330,
			eastMeters: -250,
			rating: 4.5,
			cost: 28,
			mealMinutes: 25,
			tags: ["咖啡", "美式"],
		},
		{
			id: "demo-coffee-signal-004",
			name: "演示·信号灯咖啡站",
			northMeters: -460,
			eastMeters: -210,
			rating: null,
			cost: 21,
			mealMinutes: 18,
			tags: ["咖啡", "外带"],
		},
	]),
	DESSERT: Object.freeze([
		{
			id: "demo-dessert-moon-001",
			name: "演示·月光甜品工坊",
			northMeters: 130,
			eastMeters: 100,
			rating: 4.5,
			cost: 25,
			mealMinutes: 24,
			tags: ["甜品", "蛋糕"],
		},
		{
			id: "demo-dessert-cube-002",
			name: "演示·方糖布丁屋",
			northMeters: -220,
			eastMeters: 200,
			rating: 4.3,
			cost: 19,
			mealMinutes: 20,
			tags: ["甜品", "布丁"],
		},
		{
			id: "demo-dessert-comet-003",
			name: "演示·彗星冰品站",
			northMeters: 340,
			eastMeters: -230,
			rating: 4.4,
			cost: 22,
			mealMinutes: 18,
			tags: ["甜品", "冰品"],
		},
		{
			id: "demo-dessert-cloud-004",
			name: "演示·云端烘焙室",
			northMeters: -450,
			eastMeters: -230,
			rating: null,
			cost: 17,
			mealMinutes: 21,
			tags: ["甜品", "烘焙"],
		},
	]),
});

const SUPPORTED_PROFILE_VERSIONS = new Set([
	"MEAL:meal-breakfast-v1",
	"MEAL:meal-lunch-v1",
	"MEAL:meal-dinner-v1",
	"MILK_TEA:milk-tea-v1",
	"COFFEE:coffee-v1",
	"DESSERT:dessert-v1",
]);

function weatherSelectionIndexes(
	queryModifier: WeatherQueryModifier,
): readonly number[] {
	switch (queryModifier) {
		case "MINIMIZE_OUTDOOR_EXPOSURE":
			return [0, 1, 2];
		case "PREFER_WARMING_OPTIONS":
			return [1, 2, 3];
		case "PREFER_COOLING_OPTIONS":
			return [0, 2, 3];
		default:
			return assertNeverWeatherModifier(queryModifier);
	}
}

function weatherTag(queryModifier: WeatherQueryModifier): string {
	switch (queryModifier) {
		case "MINIMIZE_OUTDOOR_EXPOSURE":
			return "演示查询条件·用户自报少户外已应用";
		case "PREFER_WARMING_OPTIONS":
			return "演示查询条件·用户自报偏暖已应用";
		case "PREFER_COOLING_OPTIONS":
			return "演示查询条件·用户自报偏凉已应用";
		default:
			return assertNeverWeatherModifier(queryModifier);
	}
}

function assertNeverWeatherModifier(value: never): never {
	throw new Error(`Unsupported weather query modifier: ${String(value)}`);
}

function selectTemplates(
	templates: readonly DemoTemplate[],
	plan: RecommendationQueryPlan,
): readonly Readonly<{ template: DemoTemplate; providerRank: number }>[] {
	if (plan.weatherApplication.kind === "NONE") {
		return templates.map((template, index) => ({
			template,
			providerRank: index + 1,
		}));
	}

	// These are deterministic demo-query partitions, not claims about real venue
	// temperature or exposure. Keep original ranks so LIVE display remains in the
	// provider's stable order after the request-scoped selection.
	return weatherSelectionIndexes(plan.weatherApplication.queryModifier).map(
		(index) => {
			const template = templates[index];
			if (template === undefined) throw new Error("DEMO_TEMPLATE_MISSING");
			return { template, providerRank: index + 1 };
		},
	);
}

function periodTag(period: MealPeriod): string {
	if (period === "BREAKFAST") return "早餐";
	if (period === "DINNER") return "晚餐";
	return "午餐";
}

function offsetLocation(
	origin: RecommendationContext["location"],
	northMeters: number,
	eastMeters: number,
): { latitude: number; longitude: number; crs: "WGS84" | "GCJ02" } {
	const latitude = origin.latitude + northMeters / 111_320;
	const metersPerLongitudeDegree = Math.max(
		1,
		111_320 * Math.cos((origin.latitude * Math.PI) / 180),
	);
	return {
		latitude,
		longitude: origin.longitude + eastMeters / metersPerLongitudeDegree,
		crs: coordinateReferenceSystem(origin),
	};
}

@Injectable()
export class DemoPlaceProvider implements PlaceProvider {
	readonly kind = "DEMO" as const;
	readonly dataMode = "DEMO" as const;

	supportsQueryPlan(plan: RecommendationQueryPlan): boolean {
		const profileSupported = SUPPORTED_PROFILE_VERSIONS.has(
			`${plan.profile.target}:${plan.profile.version}`,
		);
		const expectedCapability = plan.profile.target !== "MEAL";
		const capabilityConsistent =
			plan.providerCapabilityRequired === expectedCapability &&
			plan.profile.providerCapabilityRequired === expectedCapability;
		const weatherSupported =
			(plan.weatherApplication.kind === "NONE" &&
				plan.weatherApplication.version === "weather-none-v1") ||
			(plan.weatherApplication.kind === "USER_REPORTED" &&
				plan.weatherApplication.version === "user-reported-weather-v1");
		return profileSupported && capabilityConsistent && weatherSupported;
	}

	async search(
		context: RecommendationContext,
		plan: RecommendationQueryPlan,
	): Promise<readonly PlaceCandidate[]> {
		if (!this.supportsQueryPlan(plan)) {
			throw new Error("UNSUPPORTED_RECOMMENDATION_QUERY_PLAN");
		}
		const templates =
			plan.profile.target === "MEAL"
				? DEMO_TEMPLATES
				: VERTICAL_DEMO_TEMPLATES[plan.profile.target];
		return selectTemplates(templates, plan).map(
			({ template, providerRank }) => {
				const location = offsetLocation(
					context.location,
					template.northMeters,
					template.eastMeters,
				);
				const distanceMeters = haversineDistanceMetersUnrounded(
					context.location,
					location,
				);
				return {
					provider: "DEMO" as const,
					providerPlaceId: template.id,
					providerRank,
					dataMode: "DEMO" as const,
					actions: {
						navigate: true,
						call: true,
						copyAddress: true,
						share: false,
					},
					name: template.name,
					address: "虚构演示地址（不对应真实商户）",
					sourceRating: template.rating,
					averageCostYuan: template.cost,
					distanceMeters,
					estimatedTravelMinutes: estimateTravelMinutes(
						distanceMeters,
						context.travelMode,
					),
					estimatedMealMinutes: template.mealMinutes,
					openStatus: "OPEN" as const,
					tags: [
						...template.tags,
						...(plan.profile.target === "MEAL" ? [] : [plan.preferredTerm]),
						periodTag(context.mealPeriod),
						...(plan.weatherApplication.kind === "USER_REPORTED"
							? [weatherTag(plan.weatherApplication.queryModifier)]
							: []),
						"演示数据",
					],
					imageUrl: null,
					phone: null,
					location,
					sourceAttribution: "虚构演示数据，不可用于真实就餐决策",
					editorialAdjustment: 0,
					blocked: false,
				};
			},
		);
	}
}
