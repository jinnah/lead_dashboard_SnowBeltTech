import { NextResponse } from "next/server";
import { canAssign } from "@/lib/access";
import { ACTION_FORM_MAX_BYTES, readBoundedForm } from "@/lib/server/forms";
import { logEvent, newRequestId } from "@/lib/server/http";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { getViewer } from "@/lib/server/viewer";
import { parseLeadAction, type ActionError } from "@/lib/lead-actions";

// Customer lead actions (status, follow-up, notes, assignment). Runs under the
// signed-in user's ordinary session (anon key + RLS) — never the service-role
// client. Authority: the lead must be visible through RLS and belong to one of
// the viewer's active businesses; the viewer's role for THAT business comes from
// their own RLS-visible membership row; nothing in the form can name a tenant,
// actor or role. Post/Redirect/Get with allow-listed result codes only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ErrCode = ActionError | "not_found" | "failed" | "not_allowed" | "assignment_rejected";

function back(request: Request, id: string, result: { ok: string } | { err: ErrCode }): NextResponse {
  const url = new URL(`/dashboard/leads/${id}`, request.url);
  if ("ok" in result) url.searchParams.set("ok", result.ok);
  else url.searchParams.set("err", result.err);
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

function opaque(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const requestId = newRequestId();
  const { id } = await ctx.params;
  if (!isSameSiteRequest(request.headers)) return opaque(403, "forbidden");
  if (!UUID.test(id)) return opaque(404, "not_found");

  const viewer = await getViewer();
  if (!viewer) return opaque(401, "unauthorized");
  if (viewer.access.kind !== "customer") return opaque(404, "not_found");

  const form = await readBoundedForm(request, ACTION_FORM_MAX_BYTES);
  if (!form.ok) {
    logEvent({ requestId, event: "lead_action", status: form.status, category: form.error });
    return opaque(form.status, form.error);
  }

  const { supabase } = viewer;
  // The lead's business comes from the RLS-visible row, never from the request.
  const { data: lead } = await supabase
    .from("leads")
    .select("id, business_id, status, follow_up_at")
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle<{ id: string; business_id: string; status: string; follow_up_at: string | null }>();
  const business = lead ? viewer.access.businesses.find((b) => b.id === lead.business_id) : undefined;
  if (!lead || !business) {
    logEvent({ requestId, event: "lead_action", status: 404, category: "not_found" });
    return opaque(404, "not_found");
  }

  const parsed = parseLeadAction(form.fields, business.timezone);
  if (!parsed.ok) {
    logEvent({ requestId, event: "lead_action", status: 303, category: parsed.error });
    return back(request, id, { err: parsed.error });
  }
  const action = parsed.action;

  if (action.kind === "add_note") {
    const { data, error } = await supabase.rpc("add_lead_note", { p_lead_id: id, p_note: action.note, p_request_id: action.requestId }).single<{ activity_id: string; replayed: boolean }>();
    if (error || !data) {
      const category = error?.code === "P0002" ? "not_found" : "rpc_error";
      logEvent({ requestId, event: "lead_action", action: "add_note", status: 303, category, sqlstate: error?.code ?? null });
      return back(request, id, { err: category === "not_found" ? "not_found" : "failed" });
    }
    logEvent({ requestId, event: "lead_action", action: "add_note", status: 303, category: "ok", replayed: data.replayed });
    return back(request, id, { ok: "add_note" });
  }

  if (action.kind === "set_assignee") {
    // Role for THIS business from the viewer's own RLS-visible membership (the RPC re-checks independently).
    if (!canAssign(viewer.access, business.id)) {
      logEvent({ requestId, event: "lead_action", action: "set_assignee", status: 303, category: "not_allowed" });
      return back(request, id, { err: "not_allowed" });
    }
    const { data, error } = await supabase.rpc("set_lead_assignee", { p_lead_id: id, p_assignee_id: action.assigneeId }).single<{ lead_id: string; assigned_to: string | null; changed: boolean }>();
    if (error || !data) {
      // unknown/foreign lead, invalid/inactive/cross-business assignee, revoked caller: one opaque outcome
      const category = error?.code === "P0002" ? "assignment_rejected" : "rpc_error";
      logEvent({ requestId, event: "lead_action", action: "set_assignee", status: 303, category, sqlstate: error?.code ?? null });
      return back(request, id, { err: category === "assignment_rejected" ? "assignment_rejected" : "failed" });
    }
    logEvent({ requestId, event: "lead_action", action: "set_assignee", status: 303, category: "ok", changed: data.changed });
    return back(request, id, { ok: "set_assignee" });
  }

  const patch: { status?: string; follow_up_at?: string | null } =
    action.kind === "set_status" ? { status: action.status } : action.kind === "set_follow_up" ? { follow_up_at: action.at.toISOString() } : { follow_up_at: null };
  // Fail closed: the update must be confirmed by the database (exactly one authorized row).
  const { data: updated, error } = await supabase.from("leads").update(patch).eq("id", id).eq("business_id", lead.business_id).is("archived_at", null).select("id");
  if (error || !updated || updated.length !== 1) {
    logEvent({ requestId, event: "lead_action", action: action.kind, status: 303, category: error ? "db_error" : "no_rows", sqlstate: error?.code ?? null });
    return back(request, id, { err: "failed" });
  }
  logEvent({ requestId, event: "lead_action", action: action.kind, status: 303, category: "ok" });
  return back(request, id, { ok: action.kind });
}
