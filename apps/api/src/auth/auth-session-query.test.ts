import { ListSessionsQuerySchema } from "@chi-shen-me/contracts";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ZodBodyPipe } from "../common/zod-body.pipe.js";
import { AuthController } from "./auth.controller.js";
import type { AuthService } from "./auth.service.js";

describe("session list platform negotiation", () => {
	it.each([{}, { includePlatforms: "ALL" as const }])("passes validated client capability to the service: %j", (query) => {
		const listSessions = vi.fn(() => ({ items: [] }));
		const controller = new AuthController({ listSessions } as unknown as AuthService);
		const parsed = new ZodBodyPipe(ListSessionsQuerySchema).transform(query);
		controller.listSessions(`Bearer ${"a".repeat(43)}`, parsed);
		expect(listSessions).toHaveBeenCalledWith("a".repeat(43), query);
	});
	it.each([{ includePlatforms: "UNKNOWN" }, { includePlatforms: ["ALL", "ALL"] }, { userId: "another-user" }])("rejects invalid capability as 400: %j", (query) => {
		expect(() => new ZodBodyPipe(ListSessionsQuerySchema).transform(query)).toThrow(BadRequestException);
	});
});
