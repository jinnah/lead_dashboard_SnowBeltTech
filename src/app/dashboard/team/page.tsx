import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfirmForm } from "@/components/confirm-form";
import { canManageTeam, customerRoleLabel, ROLE_DISPLAY_LABELS, selectBusiness, type BusinessRole } from "@/lib/access";
import { ADMIN_ERROR_MESSAGES, ADMIN_OK_MESSAGES, EMAIL_MAX, type AdminOk, type AdminResultError } from "@/lib/admin-actions";
import { TEAM_GRANTABLE_ROLES } from "@/lib/team-actions";
import { getViewer, loadTeam } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

// Owner-only Team & access page. Reaching it requires a validated session AND
// an active BUSINESS_OWNER membership in the SELECTED business (the slug is a
// preference validated against the RLS-authorized list; everyone else is sent
// back to their workspace). Rendering exposes display names, roles, statuses
// and invitation emails the owner created - never UUIDs beyond form values the
// server fully re-authorizes, and never tokens, ledgers or foreign tenants.
const OK_KEYS: readonly AdminOk[] = ["invited", "invitation_revoked", "member_role_updated", "member_status_updated"];
const ERR_KEYS: readonly (AdminResultError | string)[] = [
  "unsupported_action", "missing_field", "duplicate_field", "unexpected_field",
  "invalid_email", "invalid_display_name", "invalid_role", "invalid_member", "invalid_invitation", "invalid_status",
  "email_in_use", "invitation_exists", "invite_delivery_failed", "self_forbidden", "owner_protected",
  "not_operable", "last_owner", "not_allowed", "not_found", "failed",
];

interface InvitationRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
}

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ business?: string; ok?: string; err?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind === "admin") redirect("/admin");
  if (viewer.access.kind !== "customer") redirect("/no-access");

  const params = await searchParams;
  const business = selectBusiness(viewer.access.businesses, params.business);
  if (!business) redirect("/no-access");
  // Owner-only: managers and staff return to their lead workspace.
  if (!canManageTeam(viewer.access, business.id)) redirect(`/dashboard?business=${encodeURIComponent(business.slug)}`);

  const team = await loadTeam(viewer, business.id);
  // Live invitations for THIS business only (owner-scoped RLS policy).
  const { data: invitationRows } = await viewer.supabase
    .from("customer_invitations")
    .select("id, email, display_name, role, status")
    .eq("business_id", business.id)
    .in("status", ["prepared", "sent"])
    .order("created_at", { ascending: false })
    .returns<InvitationRow[]>();
  const invitations = invitationRows ?? [];

  const okMsg = params.ok && (OK_KEYS as readonly string[]).includes(params.ok) ? ADMIN_OK_MESSAGES[params.ok as AdminOk] : null;
  const errMsg = params.err && (ERR_KEYS as readonly string[]).includes(params.err) ? ADMIN_ERROR_MESSAGES[params.err as AdminResultError] : null;
  const roleLabel = (role: string) => ROLE_DISPLAY_LABELS[role as BusinessRole] ?? role;
  const teamHref = `/dashboard/team?business=${encodeURIComponent(business.slug)}`;

  return (
    <AppShell
      subtitle="Lead Portal"
      userLabel={viewer.profile.display_name || viewer.email || "Signed in"}
      roleLabel={customerRoleLabel(viewer.access, business.id)}
      nav={[
        { href: `/dashboard?business=${encodeURIComponent(business.slug)}`, label: "Leads" },
        { href: teamHref, label: "Team & access", current: true },
      ]}
    >
      <div className="page-head">
        <div>
          <div className="eyebrow">{business.name}</div>
          <h1>Team &amp; access</h1>
          <p className="muted">
            Owners control who can access this business&apos;s lead workspace. Deactivating a member removes
            their access immediately; their history is kept. Owner access itself is managed by SnowBeltTech.
          </p>
        </div>
        <a className="btn btn--link" href={`/dashboard?business=${encodeURIComponent(business.slug)}`}>← Back to leads</a>
      </div>

      {okMsg ? <div className="alert alert--success" role="status">{okMsg}</div> : null}
      {errMsg ? <div className="alert alert--error" role="alert">{errMsg}</div> : null}

      <section className="card" aria-labelledby="team-h">
        <h2 id="team-h">Team members</h2>
        <div className="table-wrap">
          <table className="leads">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Access</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {team.map((m) => {
                const self = m.user_id === viewer.userId;
                const owner = m.role === "BUSINESS_OWNER";
                // Membership status and PROFILE status are separate concepts:
                // a profile deactivated by SnowBeltTech is platform-managed -
                // the owner gets a distinct read-only state and no controls
                // (the database rejects crafted requests independently).
                const manageable = !self && !owner && m.profile_active;
                const otherRole = m.role === "BUSINESS_MANAGER" ? "BUSINESS_STAFF" : "BUSINESS_MANAGER";
                return (
                  <tr key={m.user_id}>
                    <td>
                      <strong>{m.display_name}</strong>
                      {self ? <span className="muted"> (you)</span> : null}
                    </td>
                    <td>{roleLabel(m.role)}</td>
                    <td>{!m.profile_active ? "Account deactivated" : m.status === "active" ? "Active" : "Inactive"}</td>
                    <td>
                      {manageable ? (
                        <div className="team-actions">
                          {m.status === "active" ? (
                            <>
                              <form method="post" action="/api/team/actions" className="inline-form">
                                <input type="hidden" name="action" value="set_member_role" />
                                <input type="hidden" name="business" value={business.slug} />
                                <input type="hidden" name="user_id" value={m.user_id} />
                                <input type="hidden" name="role" value={otherRole} />
                                <button type="submit" className="btn btn--secondary">
                                  {`Change role to ${roleLabel(otherRole)}`}
                                </button>
                              </form>
                              <ConfirmForm
                                action="/api/team/actions"
                                confirm={`Deactivate access for ${m.display_name}? They lose workspace access immediately; their history is kept.`}
                                fields={{ action: "set_member_status", business: business.slug, user_id: m.user_id, status: "inactive" }}
                              >
                                <button type="submit" className="btn btn--secondary">Deactivate access</button>
                              </ConfirmForm>
                            </>
                          ) : (
                            <form method="post" action="/api/team/actions" className="inline-form">
                              <input type="hidden" name="action" value="set_member_status" />
                              <input type="hidden" name="business" value={business.slug} />
                              <input type="hidden" name="user_id" value={m.user_id} />
                              <input type="hidden" name="status" value="active" />
                              <button type="submit" className="btn btn--secondary">Reactivate access</button>
                            </form>
                          )}
                        </div>
                      ) : (
                        <span className="muted">{owner || !m.profile_active ? "Managed by SnowBeltTech" : "—"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="invite-h" style={{ marginTop: "1.25rem" }}>
        <h2 id="invite-h">Invite team member</h2>
        <p className="muted">The invitation email contains a secure link; the new member sets their own password. Invitations expire after one hour.</p>
        <form method="post" action="/api/team/actions" className="filters">
          <input type="hidden" name="action" value="invite_member" />
          <input type="hidden" name="business" value={business.slug} />
          <label className="field">
            <span className="field__label">Email</span>
            <input className="field__input" type="email" name="email" required maxLength={EMAIL_MAX} />
          </label>
          <label className="field">
            <span className="field__label">Name</span>
            <input className="field__input" type="text" name="display_name" required maxLength={100} />
          </label>
          <label className="field">
            <span className="field__label">Role</span>
            <select className="field__input" name="role" defaultValue="BUSINESS_STAFF">
              {TEAM_GRANTABLE_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_DISPLAY_LABELS[r]}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn--primary">Invite team member</button>
        </form>
      </section>

      <section className="card" aria-labelledby="pending-h" style={{ marginTop: "1.25rem" }}>
        <h2 id="pending-h">Pending invitations</h2>
        {invitations.length === 0 ? (
          <div className="empty">No pending invitations.</div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.email}</td>
                    <td>{inv.display_name}</td>
                    <td>{roleLabel(inv.role)}</td>
                    <td>Pending invitation</td>
                    <td>
                      <ConfirmForm
                        action="/api/team/actions"
                        confirm={`Revoke the pending invitation for ${inv.email}? The emailed link stops working immediately.`}
                        fields={{ action: "revoke_invitation", business: business.slug, invitation_id: inv.id }}
                      >
                        <button type="submit" className="btn btn--secondary">Revoke</button>
                      </ConfirmForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}
