import type { FeatureConfig } from "@chi-shen-me/contracts";
import { Controller, Get } from "@nestjs/common";
import { FeatureConfigService } from "./feature-config.service.js";

@Controller("v1/config")
export class FeatureConfigController {
	constructor(private readonly featureConfig: FeatureConfigService) {}

	@Get()
	getConfig(): Promise<FeatureConfig> {
		return this.featureConfig.getPublicConfig();
	}
}
