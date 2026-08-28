import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { EMAIL_MAX } from "@/lib/admin-actions";
import { FORGOT_PASSWORD_MESSAGES, PASSWORD_RESET_SENT_MESSAGE } from "@/lib/password-reset";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

// Public forgot-password entry point. Deliberately reveals nothing: the same
// generic confirmation renders whether or not an account exists, the submitted
// email never appears in a URL, and there is no signup or account-creation
// control anywhere in this flow. Responses are non-cacheable (session proxy
// sets Cache-Control: private, no-store on every page).
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ err?: string; ok?: string }> }) {
  const viewer = await getViewer();
  if (viewer) redirect("/"); // signed-in users go through normal root role routing
  const sp = await searchParams;
  const errMsg = sp.err && sp.err in FORGOT_PASSWORD_MESSAGES ? FORGOT_PASSWORD_MESSAGES[sp.err as keyof typeof FORGOT_PASSWORD_MESSAGES] : null;
  const sent = sp.ok === "sent";

  return (
    <div className="login-wrap">
      <main className="login-card">
        <Brand subtitle="Lead Portal" />
        <h1>Reset your password</h1>
        <p className="muted">
          Enter the email address you sign in with. If an eligible account exists for that email,
          password-reset instructions will be sent to it. For your security, this page never
          confirms whether an account exists.
        </p>
        {sent ? (
          <div className="alert alert--success" role="status">
            {PASSWORD_RESET_SENT_MESSAGE}
          </div>
        ) : null}
        {errMsg ? (
          <div className="alert alert--error" role="alert">
            {errMsg}
          </div>
        ) : null}
        <form method="post" action="/api/auth/password-reset/request" noValidate>
          <label className="field">
            <span className="field__label">Email</span>
            <input className="field__input" type="email" name="email" autoComplete="username" required maxLength={EMAIL_MAX} />
          </label>
          <button type="submit" className="btn btn--primary" style={{ width: "100%" }}>
            Send reset instructions
          </button>
        </form>
        <p className="muted" style={{ marginTop: "1.25rem", fontSize: "0.85rem" }}>
          <a href="/login">Back to sign in</a>
        </p>
      </main>
    </div>
  );
}
