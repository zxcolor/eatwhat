import {
	evaluateRestaurantActions,
	type RecommendationResult,
	type RestaurantActionAvailability,
	type ResultSessionState,
} from "../../features/decision/index";

export interface RestaurantDetailView {
	readonly name: string;
	readonly address: string;
	readonly imageUrl: string | null;
	readonly openText: string;
	readonly costText: string;
	readonly ratingText: string;
	readonly distanceText: string;
	readonly timingText: string;
	readonly tags: readonly string[];
	readonly reasons: readonly string[];
	readonly warnings: readonly string[];
	readonly confidenceText: string;
	readonly aiText: string;
	readonly sourceAttribution: string;
	readonly dataModeLabel: string;
	readonly navigateEnabled: boolean;
	readonly callEnabled: boolean;
	readonly copyEnabled: boolean;
	readonly actionMessages: readonly string[];
}

export function projectRestaurantDetail(
	result: RecommendationResult,
	sessionState: ResultSessionState,
): RestaurantDetailView {
	const availability = evaluateRestaurantActions(result, sessionState);
	return Object.freeze({
		name: result.name,
		address: result.address.trim().length === 0 ? "地址待确认" : result.address,
		imageUrl: result.imageUrl,
		openText:
			result.openStatus === "OPEN"
				? "营业中"
				: result.openStatus === "CLOSED"
					? "已打烊"
					: "营业状态待确认",
		costText:
			result.averageCostYuan === null
				? "人均未知"
				: `人均约 ¥${Math.round(result.averageCostYuan)}`,
		ratingText:
			result.sourceRating === null
				? "评分未知"
				: `来源评分 ${result.sourceRating.toFixed(1)}`,
		distanceText:
			result.distanceMeters >= 1_000
				? `${(result.distanceMeters / 1_000).toFixed(1)} km`
				: `${Math.round(result.distanceMeters)} m`,
		timingText: `约 ${Math.round(result.estimatedTravelMinutes)} 分钟到达 · 预计用餐 ${Math.round(result.estimatedMealMinutes)} 分钟`,
		tags: Object.freeze([...result.tags]),
		reasons: Object.freeze(result.reasons.map((reason) => reason.text)),
		warnings: Object.freeze([...result.warnings]),
		confidenceText:
			result.confidence === "HIGH"
				? "高置信"
				: result.confidence === "MEDIUM"
					? "中等置信"
					: "低置信",
		aiText: result.aiAssisted
			? "本次偏好理解使用了 AI 辅助"
			: "本次结果未使用 AI 辅助",
		sourceAttribution: result.sourceAttribution,
		dataModeLabel:
			result.dataMode === "DEMO" ? "演示数据 · 虚构地点" : "实时来源",
		navigateEnabled: availability.navigate.enabled,
		callEnabled: availability.call.enabled,
		copyEnabled: availability.copyAddress.enabled,
		actionMessages: Object.freeze(actionMessages(availability)),
	});
}

function actionMessages(availability: RestaurantActionAvailability): string[] {
	const reasons = [
		availability.navigate.unavailableReason,
		availability.call.unavailableReason,
		availability.copyAddress.unavailableReason,
	];
	return [...new Set(reasons.filter((reason) => reason !== null))].map(
		(reason) => {
			switch (reason) {
				case "CONFIG_UNCONFIRMED":
					return "正在重新确认数据授权，当前结果暂不可操作。";
				case "SESSION_EXPIRED":
					return "本次结果已失效，请重新获取。";
				case "SOURCE_NOT_ENABLED":
					return "当前数据来源尚未开放部分操作。";
				case "MISSING_NAVIGATION_FACTS":
					return "暂无可用于地图查询的可靠名称或地址。";
				case "MISSING_PHONE":
					return "暂无可靠电话，暂时无法联系商户。";
				case "MISSING_ADDRESS":
					return "暂无可靠地址，暂时无法复制。";
				case "CLIENT_FEATURE_DISABLED":
					return "当前版本未开放此操作。";
				case null:
					return "";
				default:
					return "当前操作暂不可用。";
			}
		},
	);
}
