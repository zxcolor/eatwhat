import type { MealPeriod, RecommendationContext } from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import {
	coordinateReferenceSystem,
	estimateTravelMinutes,
	haversineDistanceMeters,
} from "../domain/geo.js";
import type {
	PlaceCandidate,
	PlaceProvider,
} from "../domain/place-candidate.js";

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

	async search(
		context: RecommendationContext,
	): Promise<readonly PlaceCandidate[]> {
		return DEMO_TEMPLATES.map((template, index) => {
			const location = offsetLocation(
				context.location,
				template.northMeters,
				template.eastMeters,
			);
			const distanceMeters = haversineDistanceMeters(
				context.location,
				location,
			);
			return {
				provider: "DEMO" as const,
				providerPlaceId: template.id,
				providerRank: index + 1,
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
				tags: [...template.tags, periodTag(context.mealPeriod), "演示数据"],
				imageUrl: null,
				phone: null,
				location,
				sourceAttribution: "虚构演示数据，不可用于真实就餐决策",
				editorialAdjustment: 0,
				blocked: false,
			};
		});
	}
}
