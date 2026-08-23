import { Inject, Injectable } from "@nestjs/common";
import {
	AUTHENTICATED_USER_RESOLVER,
	type AuthenticatedUserContext,
	type AuthenticatedUserResolver,
} from "../auth/authenticated-user.resolver.js";

@Injectable()
export class PersistenceUserService {
	constructor(
		@Inject(AUTHENTICATED_USER_RESOLVER)
		private readonly resolver: AuthenticatedUserResolver,
	) {}

	resolve(authorization: unknown): Promise<AuthenticatedUserContext> {
		return this.resolver.resolveAuthorization(authorization);
	}
}
