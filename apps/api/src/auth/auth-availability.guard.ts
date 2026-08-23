import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { AuthUnavailableException } from "./auth-errors.js";

@Injectable()
export class AuthAvailabilityGuard implements CanActivate {
	constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

	canActivate(_context: ExecutionContext): boolean {
		if (!this.config.auth.enabled) throw new AuthUnavailableException();
		return true;
	}
}
