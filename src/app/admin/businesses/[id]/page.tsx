import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BusinessStatusBadge } from "@/components/badges";
import {
  ADMIN_ERROR_MESSAGES, ADMIN_OK_MESSAGES, describeAdminEvent, EXTERNAL_ID_MAX, INDUSTRY_LABELS, LABEL_MAX,
  REGISTRABLE_SOURCE_KINDS, SOURCE_KIND_LABELS, type AdminEventRow, type AdminOk, type AdminResultError,
} from "@/lib/admin-actions";
import { formatDateTime } from "@/lib/format";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BusinessDetail { id: string; name: string; slug: string; industry: string; timezone: string; status: string; created_at: string }
interface SourceRow { id: string; kind: string; external_id: string; label: string | null; allowed_origin: string | null; status: string; created_at: string }

// Administrator business configuration: lifecycle (suspend/reactivate), trusted
// integration sources and the platform-operations ledger. Everything is read
// and written through the administrator's own session; mutations go through the
// reviewed admin_* RPCs via the per-business action route. Archived businesses
// are shown without controls. No lead-editing or assignment controls exist here.
export default async function AdminBusinessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind !== "admin") redirect("/");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { supabase } = viewer;

  const { data: business } = await supabase.from("businesses").select("id, name, slug, industry, timezone, status, created_at").eq("id", id).maybeSingle<BusinessDetail>();
  if (!business) notFound();
  const tz = business.timezone;

  const [total, fresh, { data: sources }, { data: events }] = await Promise.all([
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("business_id", business.id).is("archived_at", null),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("business_id", business.id).is("archived_at", null).eq("status", "new"),
    supabase.from("integration_sources").select("id, kind, external_id, label, allowed_origin, status, created_at").eq("business_id", business.id).order("created_at", { ascending: true }).returns<SourceRow[]>(),
    supabase.from("platform_admin_events").select("id, event_type, integration_source_id, actor_display_name, old_value, new_value, created_at").eq("business_id", business.id).order("created_at", { ascending: false }).limit(50).returns<AdminEventRow[]>(),
  ]);
  const sourceList = sources ?? [];
  const sourceLabel = (sid: string) => {
    const s = sourceList.find((x) => x.id === sid);
    return s ? (s.label?.trim() || SOURCE_KIND_LABELS[s.kind as keyof typeof SOURCE_KIND_LABELS] || "source") : "removed source";
  };

  const sp = await searchParams;
  const okMsg = sp.ok && sp.ok in ADMIN_OK_MESSAGES ? ADMIN_OK_MESSAGES[sp.ok as AdminOk] : null;
  const errMsg = sp.err && sp.err in ADMIN_ERROR_MESSAGES ? ADMIN_ERROR_MESSAGES[sp.err as AdminResultError] : null;
  const operable = business.status === "active" || business.status === "suspended";
  const actionUrl = `/api/admin/businesses/${business.id}/actions`;

  return (
    <AppShell subtitle="Platform administration" userLabel={viewer.profile.display_name || viewer.email || "Administrator"} roleLabel="Platform administrator">
      <div className="page-head">
        <div>
          <div className="eyebrow">Customer business · <BusinessStatusBadge status={business.status} /></div>
          <h1>{business.name}</h1>
          <p className="muted">Configuration and platform operations. Times shown in {tz}.</p>
        </div>
        <a className="btn btn--link" href="/admin">← Back to overview</a>
      </div>

      {okMsg ? <div className="alert alert--success" role="status">{okMsg}</div> : null}
      {errMsg ? <div className="alert alert--error" role="alert">{errMsg}</div> : null}
      {!operable ? <div className="alert alert--info" role="status">This business is archived. It stays visible for inspection but cannot be changed here.</div> : null}

      <section className="stats" aria-label="Business summary">
        <div className="stat"><div className="stat__label">Status</div><div className="stat__value"><BusinessStatusBadge status={business.status} /></div></div>
        <div className="stat"><div className="stat__label">Leads</div><div className="stat__value">{total.count ?? 0}</div></div>
        <div className="stat"><div className="stat__label">New leads</div><div className="stat__value">{fresh.count ?? 0}</div></div>
        <div className="stat"><div className="stat__label">Sources</div><div className="stat__value">{sourceList.length}</div></div>
      </section>

      <div className="detail-grid">
        <section className="card" aria-labelledby="cfg-h">
          <h2 id="cfg-h">Configuration</h2>
          <dl className="kv">
            <dt>Name</dt><dd>{business.name}</dd>
            <dt>Slug</dt><dd><code>{business.slug}</code></dd>
            <dt>Industry</dt><dd>{INDUSTRY_LABELS[business.industry as keyof typeof INDUSTRY_LABELS] ?? business.industry}</dd>
            <dt>Timezone</dt><dd>{business.timezone}</dd>
            <dt>Created</dt><dd>{formatDateTime(business.created_at, tz)}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="life-h">
          <h2 id="life-h">Lifecycle</h2>
          {operable ? (
            business.status === "active" ? (
              <form method="post" action={actionUrl} className="inline-form">
                <input type="hidden" name="action" value="set_business_status" />
                <input type="hidden" name="status" value="suspended" />
                <p className="muted">Suspending removes customer access and stops lead ingestion immediately. Leads and sources are kept.</p>
                <button type="submit" className="btn btn--secondary">Suspend business</button>
              </form>
            ) : (
              <form method="post" action={actionUrl} className="inline-form">
                <input type="hidden" name="action" value="set_business_status" />
                <input type="hidden" name="status" value="active" />
                <p className="muted">Reactivating restores member access and lead ingestion for active sources.</p>
                <button type="submit" className="btn btn--primary">Reactivate business</button>
              </form>
            )
          ) : (
            <p className="muted">Archived businesses cannot be suspended or reactivated.</p>
          )}
        </section>

        <section className="card card--wide" aria-labelledby="src-h">
          <h2 id="src-h">Integration sources</h2>
          <p className="muted">Trusted identifiers that route incoming leads to this business. Identifiers are registered once and never moved between businesses.</p>
          <div className="table-wrap" style={{ marginBottom: "1rem" }}>
            <table className="leads">
              <thead><tr><th scope="col">Kind</th><th scope="col">External identifier</th><th scope="col">Label</th><th scope="col">Allowed origin</th><th scope="col">Status</th><th scope="col">Registered</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {sourceList.length === 0 ? <tr><td colSpan={7} className="empty">No integration sources registered.</td></tr> : null}
                {sourceList.map((s) => (
                  <tr key={s.id}>
                    <td>{SOURCE_KIND_LABELS[s.kind as keyof typeof SOURCE_KIND_LABELS] ?? s.kind}</td>
                    <td><code>{s.external_id}</code></td>
                    <td>{s.label ?? "—"}</td>
                    <td>{s.allowed_origin ?? "—"}</td>
                    <td><span className={`badge badge--${s.status === "active" ? "active" : "archived"}`}>{s.status === "active" ? "Active" : "Inactive"}</span></td>
                    <td>{formatDateTime(s.created_at, tz)}</td>
                    <td>
                      {operable ? (
                        <form method="post" action={actionUrl}>
                          <input type="hidden" name="action" value="set_source_status" />
                          <input type="hidden" name="source_id" value={s.id} />
                          <input type="hidden" name="status" value={s.status === "active" ? "inactive" : "active"} />
                          <button type="submit" className="btn btn--secondary">{s.status === "active" ? "Deactivate" : "Activate"}</button>
                        </form>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {operable && business.status === "active" ? (
            <form method="post" action={actionUrl} className="inline-form">
              <h3>Register a source</h3>
              <input type="hidden" name="action" value="create_source" />
              <div className="actions__grid">
                <label className="field">
                  <span className="field__label">Kind</span>
                  <select className="field__input" name="kind" required defaultValue="website_form">
                    {REGISTRABLE_SOURCE_KINDS.map((k) => <option key={k} value={k}>{SOURCE_KIND_LABELS[k]}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">External identifier (exact)</span>
                  <input className="field__input" type="text" name="external_id" required maxLength={EXTERNAL_ID_MAX} autoComplete="off" spellCheck={false} />
                </label>
                <label className="field">
                  <span className="field__label">Label (optional)</span>
                  <input className="field__input" type="text" name="label" maxLength={LABEL_MAX} autoComplete="off" />
                </label>
                <label className="field">
                  <span className="field__label">Allowed origin (website forms only, e.g. https://www.example.com)</span>
                  <input className="field__input" type="text" name="allowed_origin" inputMode="url" autoComplete="off" spellCheck={false} />
                </label>
              </div>
              <button type="submit" className="btn btn--primary">Register source</button>
            </form>
          ) : operable ? <p className="muted">Reactivate the business before registering new sources.</p> : null}
        </section>

        <section className="card card--wide" aria-labelledby="ops-h">
          <h2 id="ops-h">Platform operations history</h2>
          <p className="muted">Immutable record of administrator operations on this business (most recent first).</p>
          {(events ?? []).length === 0 ? <p className="empty">No platform operations recorded.</p> : (
            <ol className="timeline">
              {(events ?? []).map((e) => (
                <li key={e.id} className="timeline__item">
                  <div className="timeline__meta">{formatDateTime(e.created_at, tz)} · {e.actor_display_name?.trim() || "Former administrator"}</div>
                  <div>{describeAdminEvent(e, sourceLabel)}</div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </AppShell>
  );
}
