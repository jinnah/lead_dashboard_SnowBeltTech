import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { ACCOUNT_SETUP_MESSAGES, PASSWORD_MAX, PASSWORD_MIN } from "@/lib/account-setup";
import { createServerSupabase } from "@/lib/server/supabase-server";

export const dynamic = "force-dynamic";

// New-password page reached from a verified recovery link (or by any signed-in
// user replacing their OWN password). Identity is validated with the Auth
// server (auth.getUser()), never by decoding a local JWT. Deliberately shows
// NO tenant, lead, membership, invitation or administrator data and does not
// require a tenant membership: an inactive or suspended portal user may still
// replace their own password — doing so restores nothing, because access is
// re-derived from profile/membership/business state on every request.
const RESET_ERRORS = ["missing_field", "duplicate_field", "unexpected_field", "password_too_short", "password_too_long", "password_mismatch", "failed"] as const;

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) redirect("/login?error=recovery");
  const sp = await searchParams;
  const err = RESET_ERRORS.find((e) => e === sp.err);
  const errMsg = err ? ACCOUNT_SETUP_MESSAGES[err] : null;

  return (
    <div className="login-wrap">
      <main className="login-card">
        <Brand subtitle="Lead Portal" />
        <h1>Choose a new password</h1>
        <p className="muted">Set the password you will use to sign in to the Lead Portal from now on.</p>
        {errMsg ? (
          <div className="alert alert--error" role="alert">
            {errMsg}
          </div>
        ) : null}
        <form method="post" action="/api/account/reset-password" noValidate>
          <label className="field">
            <span className="field__label">New password (at least {PASSWORD_MIN} characters)</span>
            <input className="field__input" type="password" name="password" required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} autoComplete="new-password" />
          </label>
          <label className="field">
            <span className="field__label">Confirm new password</span>
            <input className="field__input" type="password" name="password_confirm" required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} autoComplete="new-password" />
          </label>
          <button type="submit" className="btn btn--primary" style={{ width: "100%" }}>
            Save new password
          </button>
        </form>
      </main>
    </div>
  );
}
