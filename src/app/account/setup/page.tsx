import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { customerRoleLabel } from "@/lib/access";
import { ACCOUNT_SETUP_MESSAGES, PASSWORD_MAX, PASSWORD_MIN } from "@/lib/account-setup";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

// Initial password after invitation acceptance. Reachable only with a
// validated session and an active customer membership (acceptance happened in
// /auth/confirm — merely loading this page changes nothing).
export default async function AccountSetupPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind !== "customer") redirect("/");
  const sp = await searchParams;
  const errMsg = sp.err && sp.err in ACCOUNT_SETUP_MESSAGES ? ACCOUNT_SETUP_MESSAGES[sp.err as keyof typeof ACCOUNT_SETUP_MESSAGES] : null;

  return (
    <AppShell subtitle="Lead Portal" userLabel={viewer.profile.display_name || viewer.email || "Signed in"} roleLabel={customerRoleLabel(viewer.access, viewer.access.businesses[0]?.id ?? "")}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Welcome</div>
          <h1>Set your password</h1>
          <p className="muted">Choose the password you will use to sign in to the Lead Portal from now on.</p>
        </div>
      </div>
      {errMsg ? <div className="alert alert--error" role="alert">{errMsg}</div> : null}
      <section className="card" aria-labelledby="setup-h" style={{ maxWidth: "28rem" }}>
        <h2 id="setup-h">Choose a password</h2>
        <form method="post" action="/api/account/setup" className="inline-form">
          <label className="field">
            <span className="field__label">New password (at least {PASSWORD_MIN} characters)</span>
            <input className="field__input" type="password" name="password" required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} autoComplete="new-password" />
          </label>
          <label className="field">
            <span className="field__label">Confirm password</span>
            <input className="field__input" type="password" name="password_confirm" required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} autoComplete="new-password" />
          </label>
          <button type="submit" className="btn btn--primary">Save password and continue</button>
        </form>
      </section>
    </AppShell>
  );
}
