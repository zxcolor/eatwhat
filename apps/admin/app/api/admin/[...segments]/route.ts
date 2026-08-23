import type { NextRequest } from "next/server";
import { proxyAdminRequest } from "../../../../lib/admin-bff";

interface RouteContext {
  params: Promise<{ segments: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext) {
  const { segments } = await context.params;
  return proxyAdminRequest(request, segments);
}

export const dynamic = "force-dynamic";
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
