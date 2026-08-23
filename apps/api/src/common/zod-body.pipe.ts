import {
	BadRequestException,
	Injectable,
	type PipeTransform,
} from "@nestjs/common";
import type { ZodType } from "zod";

@Injectable()
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
	constructor(private readonly schema: ZodType<T>) {}

	transform(value: unknown): T {
		const result = this.schema.safeParse(value);
		if (!result.success) {
			throw new BadRequestException({
				code: "INVALID_REQUEST",
				message: "请求参数不符合接口约定",
				issues: result.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			});
		}
		return result.data;
	}
}
