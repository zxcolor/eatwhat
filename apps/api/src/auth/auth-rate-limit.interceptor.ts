import {
	type CallHandler,
	type ExecutionContext,
	Injectable,
	type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { catchError } from "rxjs/operators";
import { AuthRateLimitedException } from "./auth-errors.js";

interface HeaderResponse {
	setHeader(name: string, value: string): void;
}

@Injectable()
export class AuthRateLimitInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
		const response = context.switchToHttp().getResponse<HeaderResponse>();
		return next.handle().pipe(
			catchError((error: unknown) => {
				if (error instanceof AuthRateLimitedException) {
					response.setHeader("Retry-After", String(error.retryAfterSeconds));
				}
				throw error;
			}),
		);
	}
}
