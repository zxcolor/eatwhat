import type { PlaceSearchRequest } from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import {
	coordinateReferenceSystem,
	haversineDistanceMeters,
} from "../../recommendations/domain/geo.js";
import type {
	PlaceKeywordSearchCandidate,
	PlaceKeywordSearchProvider,
} from "../place-keyword-search.provider.js";

const DEMO_PLACES = Object.freeze([
	{
		id: "search-demo-noodle",
		name: "演示·校园牛肉面",
		address: "虚构演示地址（不对应真实商户）",
		northMeters: 180,
		eastMeters: 120,
		rating: 4.5,
		cost: 24,
		tags: ["牛肉面", "面食", "快餐"],
	},
	{
		id: "search-demo-hotpot",
		name: "演示·同学小火锅",
		address: "虚构演示地址（不对应真实商户）",
		northMeters: -520,
		eastMeters: 350,
		rating: 4.3,
		cost: 69,
		tags: ["火锅", "聚餐"],
	},
	{
		id: "search-demo-cafe",
		name: "演示·安静咖啡馆",
		address: "虚构演示地址（不对应真实商户）",
		northMeters: 860,
		eastMeters: -240,
		rating: null,
		cost: null,
		tags: ["咖啡", "饮品"],
	},
] as const);

function offset(
	origin: PlaceSearchRequest["location"],
	northMeters: number,
	eastMeters: number,
): PlaceSearchRequest["location"] {
	const metersPerLongitudeDegree = Math.max(
		1,
		111_320 * Math.cos((origin.latitude * Math.PI) / 180),
	);
	return {
		latitude: origin.latitude + northMeters / 111_320,
		longitude: origin.longitude + eastMeters / metersPerLongitudeDegree,
		crs: coordinateReferenceSystem(origin),
	};
}

@Injectable()
export class DemoPlaceKeywordSearchProvider
	implements PlaceKeywordSearchProvider
{
	readonly dataSource = "DEMO" as const;
	readonly dataMode = "DEMO" as const;

	async search(
		request: PlaceSearchRequest,
	): Promise<readonly PlaceKeywordSearchCandidate[]> {
		const keyword = request.keyword.toLocaleLowerCase("zh-CN");
		return DEMO_PLACES.map((place, index) => ({ place, index })).flatMap(
			({ place, index }) => {
				const searchable =
					`${place.name};${place.tags.join(";")}`.toLocaleLowerCase("zh-CN");
				if (!searchable.includes(keyword)) return [];
				const location = offset(
					request.location,
					place.northMeters,
					place.eastMeters,
				);
				return [
					{
						provider: "DEMO" as const,
						providerPlaceId: place.id,
						providerRank: index + 1,
						name: place.name,
						address: place.address,
						location,
						distanceMeters: haversineDistanceMeters(request.location, location),
						sourceLabel: "虚构演示餐厅数据，仅供开发测试",
						sourceRating: place.rating,
						averageCostYuan: place.cost,
						openStatus: "OPEN" as const,
						tags: [...place.tags, "演示数据"],
						dataMode: "DEMO" as const,
						actions: {
							navigate: true,
							call: false,
							copyAddress: true,
							share: false,
						},
					},
				];
			},
		);
	}
}
