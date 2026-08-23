import { NextResponse } from "next/server";
import { mapAdminRpcError, parseAdminAction } from "@/lib/admin-actions";
import { readAdminRequest, redirectTo } from "@/lib/server/admin-request";
import { logEvent, newRequestId } from "@/lib/server/http";

// Platform-level administrator operations (currently: create a business).
// Authority is re-checked inside public.admin_create_business (auth.uid() must be
// an active platform administrator); nothing in the form can name an actor,
// tenant or role. Post/Redirect/Get with allow-listed result codes only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEW = "/admin/businesses/new";

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const r = await readAdminRequest(request, requestId, "admin_platform_action");
  if (!r.ok) return r.response;

  const parsed = parseAdminAction(r.fields, "platform");
  if (!parsed.ok) {
    logEvent({ requestId, event: "admin_platform_action", status: 303, category: parsed.error });
    return redirectTo(request, NEW, { err: parsed.error });
  }
  const a = parsed.action;
  if (a.kind !== "create_business") return redirectTo(request, NEW, { err: "unsupported_action" }); // platform scope only
  const { data, error } = await r.viewer.supabase
    .rpc("admin_create_business", { p_name: a.name, p_slug: a.slug, p_industry: a.industry, p_timezone: a.timezone })
    .single<{ business_id: string; slug: string; status: string }>();
  if (error || !data) {
    const code = mapAdminRpcError(error?.code, error?.message, "create_business");
    logEvent({ requestId, event: "admin_platform_action", action: "create_business", status: 303, category: code, sqlstate: error?.code ?? null });
    return redirectTo(request, NEW, { err: code });
  }
  logEvent({ requestId, event: "admin_platform_action", action: "create_business", status: 303, category: "ok" });
  return redirectTo(request, `/admin/businesses/${data.business_id}`, { ok: "business_created" });
}
