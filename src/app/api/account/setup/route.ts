import { NextResponse } from "next/server";
import { parseAccountSetup } from "@/lib/account-setup";
import { ACTION_FORM_MAX_BYTES, readBoundedForm } from "@/lib/server/forms";
import { logEvent, newRequestId } from "@/lib/server/http";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { getViewer } from "@/lib/server/viewer";

// Initial password for a freshly accepted invitation. Requires the validated
// authenticated session AND a current active customer membership; the password
// is set only through the user's OWN Supabase session (auth.updateUser) and
// never reaches an application RPC, table, log line or URL.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(request: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  if (!isSameSiteRequest(request.headers)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "private, no-store" } });

  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  if (viewer.access.kind !== "customer") {
    logEvent({ requestId, event: "account_setup", status: 303, category: "not_ready" });
    return back(request, "/account/setup?err=not_ready");
  }

  const form = await readBoundedForm(request, ACTION_FORM_MAX_BYTES);
  if (!form.ok) {
    logEvent({ requestId, event: "account_setup", status: form.status, category: form.error });
    return NextResponse.json({ error: form.error }, { status: form.status, headers: { "Cache-Control": "private, no-store" } });
  }
  const parsed = parseAccountSetup(form.fields);
  if (!parsed.ok) {
    logEvent({ requestId, event: "account_setup", status: 303, category: parsed.error });
    return back(request, `/account/setup?err=${parsed.error}`);
  }

  const { error } = await viewer.supabase.auth.updateUser({ password: parsed.password });
  if (error) {
    logEvent({ requestId, event: "account_setup", status: 303, category: "update_rejected" });
    return back(request, "/account/setup?err=failed");
  }
  logEvent({ requestId, event: "account_setup", status: 303, category: "ok" });
  return back(request, "/dashboard");
}
