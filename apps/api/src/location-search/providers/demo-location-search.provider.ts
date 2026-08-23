import { Injectable } from "@nestjs/common";
import type {
	LocationSearchCandidate,
	LocationSearchProvider,
} from "../location-search.provider.js";

interface DemoLocation extends LocationSearchCandidate {
	readonly aliases: readonly string[];
}

const DEMO_LOCATIONS: readonly DemoLocation[] = Object.freeze([
	{
		name: "演示·北京大学东门测试点",
		address: "虚构演示地点，不对应真实门牌",
		location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
		sourceLabel: "虚构地点数据，仅供开发测试",
		providerRank: 1,
		aliases: ["北京大学", "北大", "大学东门", "校园"],
	},
	{
		name: "演示·清华园测试点",
		address: "虚构演示地点，不对应真实门牌",
		location: { latitude: 40.0001, longitude: 116.3268, crs: "WGS84" },
		sourceLabel: "虚构地点数据，仅供开发测试",
		providerRank: 2,
		aliases: ["清华大学", "清华园", "清华", "校园"],
	},
	{
		name: "演示·五道口测试点",
		address: "虚构演示地点，不对应真实门牌",
		location: { latitude: 39.9921, longitude: 116.3378, crs: "WGS84" },
		sourceLabel: "虚构地点数据，仅供开发测试",
		providerRank: 3,
		aliases: ["五道口", "地铁", "商圈"],
	},
	{
		name: "演示·中关村测试点",
		address: "虚构演示地点，不对应真实门牌",
		location: { latitude: 39.9837, longitude: 116.3157, crs: "WGS84" },
		sourceLabel: "虚构地点数据，仅供开发测试",
		providerRank: 4,
		aliases: ["中关村", "商圈", "写字楼", "zhongguancun"],
	},
	{
		name: "演示·人民大学测试点",
		address: "虚构演示地点，不对应真实门牌",
		location: { latitude: 39.9668, longitude: 116.3215, crs: "WGS84" },
		sourceLabel: "虚构地点数据，仅供开发测试",
		providerRank: 5,
		aliases: ["人民大学", "人大", "校园"],
	},
]);

function normalized(value: string): string {
	return value.trim().toLocaleLowerCase("zh-CN").replaceAll(/\s+/gu, "");
}

@Injectable()
export class DemoLocationSearchProvider implements LocationSearchProvider {
	readonly dataSource = "DEMO" as const;
	readonly dataMode = "DEMO" as const;

	async search(query: string): Promise<readonly LocationSearchCandidate[]> {
		const needle = normalized(query);
		return DEMO_LOCATIONS.filter((candidate) =>
			[candidate.name, candidate.address ?? "", ...candidate.aliases].some(
				(text) => {
					const haystack = normalized(text);
					return haystack.includes(needle) || needle.includes(haystack);
				},
			),
		).map(({ aliases: _aliases, ...candidate }) => candidate);
	}
}
