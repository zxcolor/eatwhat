import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, loadAppConfig } from "./app-config.js";
import { APP_CLOCK, type AppClock } from "./data-rights-policy.js";

const systemClock: AppClock = Object.freeze({ now: () => Date.now() });

@Global()
@Module({
	providers: [
		{ provide: APP_CONFIG, useFactory: () => loadAppConfig() },
		{ provide: APP_CLOCK, useValue: systemClock },
	],
	exports: [APP_CONFIG, APP_CLOCK],
})
export class AppConfigModule {}
