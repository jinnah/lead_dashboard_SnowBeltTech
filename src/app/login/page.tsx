import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { PASSWORD_RESET_SUCCESS_MESSAGE, RECOVERY_LINK_ERROR_MESSAGE } from "@/lib/password-reset";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

// Status handling is allow-listed: `error=recovery` renders the generic
// recovery-link failure, any other `error` value renders the unchanged generic
// sign-in failure (invitation errors included), and `notice=password_reset`
// renders the neutral post-reset message. No query value is ever reflected.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const viewer = await getViewer();
  if (viewer) redirect("/");
  const { error, notice } = await searchParams;
  return (
    <div className="login-wrap">
      <main className="login-card">
        <Brand subtitle="Lead Portal" />
        <h1>Sign in</h1>
        <p className="muted">Access your business&apos;s lead workspace.</p>
        {notice === "password_reset" ? (
          <div className="alert alert--success" role="status">
            {PASSWORD_RESET_SUCCESS_MESSAGE}
          </div>
        ) : null}
        {error === "recovery" ? (
          <div className="alert alert--error" role="alert">
            {RECOVERY_LINK_ERROR_MESSAGE}
          </div>
        ) : error ? (
          <div className="alert alert--error" role="alert">
            We couldn&apos;t sign you in. Check your email and password and try again.
          </div>
        ) : null}
        <form method="post" action="/api/auth/login" noValidate>
          <label className="field">
            <span className="field__label">Email</span>
            <input className="field__input" type="email" name="email" autoComplete="username" required maxLength={320} />
          </label>
          <label className="field">
            <span className="field__label">Password</span>
            <input className="field__input" type="password" name="password" autoComplete="current-password" required maxLength={1024} />
          </label>
          <button type="submit" className="btn btn--primary" style={{ width: "100%" }}>
            Sign in
          </button>
        </form>
        <p className="muted" style={{ marginTop: "0.85rem", fontSize: "0.85rem" }}>
          <a href="/forgot-password">Forgot your password?</a>
        </p>
        <p className="muted" style={{ marginTop: "1.25rem", fontSize: "0.85rem" }}>
          Accounts are created by SnowBeltTech. Contact your account manager if you need access.
        </p>
      </main>
    </div>
  );
}
