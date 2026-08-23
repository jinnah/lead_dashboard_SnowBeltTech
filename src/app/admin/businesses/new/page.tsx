import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ADMIN_ERROR_MESSAGES, INDUSTRIES, INDUSTRY_LABELS, NAME_MAX, type AdminResultError } from "@/lib/admin-actions";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

// Administrator-only business creation form. Submits to the platform action
// route; the database RPC re-validates everything and records business_created.
export default async function NewBusinessPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind !== "admin") redirect("/");
  const sp = await searchParams;
  const errMsg = sp.err && sp.err in ADMIN_ERROR_MESSAGES ? ADMIN_ERROR_MESSAGES[sp.err as AdminResultError] : null;

  return (
    <AppShell subtitle="Platform administration" userLabel={viewer.profile.display_name || viewer.email || "Administrator"} roleLabel="Platform administrator">
      <div className="page-head">
        <div>
          <div className="eyebrow">SnowBeltTech operations</div>
          <h1>Create a customer business</h1>
          <p className="muted">The business starts active with no members or integration sources. Invitations are a later step.</p>
        </div>
        <a className="btn btn--link" href="/admin">← Back to overview</a>
      </div>
      {errMsg ? <div className="alert alert--error" role="alert">{errMsg}</div> : null}
      <section className="card" aria-labelledby="new-biz-h">
        <h2 id="new-biz-h">Business details</h2>
        <form method="post" action="/api/admin/businesses/actions" className="inline-form">
          <input type="hidden" name="action" value="create_business" />
          <label className="field">
            <span className="field__label">Business name</span>
            <input className="field__input" type="text" name="name" required maxLength={NAME_MAX} autoComplete="off" />
          </label>
          <label className="field">
            <span className="field__label">Slug (lowercase letters, digits, hyphens)</span>
            <input className="field__input" type="text" name="slug" required maxLength={63} pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" autoComplete="off" />
          </label>
          <label className="field">
            <span className="field__label">Industry</span>
            <select className="field__input" name="industry" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {INDUSTRIES.map((i) => <option key={i} value={i}>{INDUSTRY_LABELS[i]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Timezone (IANA, e.g. America/New_York)</span>
            <input className="field__input" type="text" name="timezone" required defaultValue="America/New_York" autoComplete="off" />
          </label>
          <button type="submit" className="btn btn--primary">Create business</button>
        </form>
      </section>
    </AppShell>
  );
}
