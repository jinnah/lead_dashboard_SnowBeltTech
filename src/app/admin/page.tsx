import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BusinessStatusBadge } from "@/components/badges";
import { LeadList, type LeadListRow } from "@/components/lead-list";
import type { BusinessRow } from "@/lib/access";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

interface AdminLeadRow extends Omit<LeadListRow, "business_name"> {
  business_id: string;
}

// Platform administrator overview. Runs under the administrator's own
// authenticated session; visibility across tenants comes from the
// platform-admin RLS policies, never from the service-role client.
export default async function AdminPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind !== "admin") redirect("/");

  const { supabase } = viewer;
  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, name, slug, timezone, status")
    .order("name", { ascending: true })
    .returns<BusinessRow[]>();
  const all = businesses ?? [];
  const tzById = new Map(all.map((b) => [b.id, b.timezone]));
  const nameById = new Map(all.map((b) => [b.id, b.name]));

  const counts = await Promise.all(
    all.map(async (b) => {
      const [total, fresh] = await Promise.all([
        supabase.from("leads").select("id", { count: "exact", head: true }).eq("business_id", b.id).is("archived_at", null),
        supabase.from("leads").select("id", { count: "exact", head: true }).eq("business_id", b.id).is("archived_at", null).eq("status", "new"),
      ]);
      return { id: b.id, total: total.count ?? 0, fresh: fresh.count ?? 0 };
    }),
  );
  const countById = new Map(counts.map((c) => [c.id, c]));

  const { data: recent } = await supabase
    .from("leads")
    .select("id, business_id, lead_number, contact_name, phone_e164, email, requested_service, source, status, urgency, review_recommended, created_at")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<AdminLeadRow[]>();
  const leads: LeadListRow[] = (recent ?? []).map((l) => ({ ...l, business_name: nameById.get(l.business_id) ?? "—" }));
  const totalLeads = counts.reduce((s, c) => s + c.total, 0);

  return (
    <AppShell subtitle="Platform administration" userLabel={viewer.profile.display_name || viewer.email || "Administrator"} roleLabel="Platform administrator">
      <div className="page-head">
        <div>
          <div className="eyebrow">SnowBeltTech operations</div>
          <h1>Platform overview</h1>
          <p className="muted">All customer businesses and their leads, read through your administrator session.</p>
        </div>
      </div>
      <section className="stats" aria-label="Platform summary">
        <div className="stat"><div className="stat__label">Businesses</div><div className="stat__value">{all.length}</div></div>
        <div className="stat"><div className="stat__label">Active</div><div className="stat__value">{all.filter((b) => b.status === "active").length}</div></div>
        <div className={`stat${all.some((b) => b.status !== "active") ? " stat--warn" : ""}`}><div className="stat__label">Suspended / archived</div><div className="stat__value">{all.filter((b) => b.status !== "active").length}</div></div>
        <div className="stat"><div className="stat__label">Leads (all)</div><div className="stat__value">{totalLeads}</div></div>
      </section>
      <section aria-labelledby="biz-h">
        <h2 id="biz-h">Customer businesses</h2>
        <div className="table-wrap" style={{ marginBottom: "1.5rem" }}>
          <table className="leads">
            <thead><tr><th scope="col">Business</th><th scope="col">Slug</th><th scope="col">Status</th><th scope="col">Timezone</th><th scope="col">Leads</th><th scope="col">New</th></tr></thead>
            <tbody>
              {all.length === 0 ? <tr><td colSpan={6} className="empty">No businesses.</td></tr> : null}
              {all.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.name}</strong></td>
                  <td className="muted">{b.slug}</td>
                  <td><BusinessStatusBadge status={b.status} /></td>
                  <td>{b.timezone}</td>
                  <td>{countById.get(b.id)?.total ?? 0}</td>
                  <td>{countById.get(b.id)?.fresh ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="recent-h">
        <h2 id="recent-h">Recent leads across customers</h2>
        <LeadList leads={leads} timeZoneFor={(l) => tzById.get((l as AdminLeadRow).business_id ?? "") ?? "UTC"} linkBase="/admin/leads" showBusiness emptyText="No leads yet." />
      </section>
    </AppShell>
  );
}
